/**
 * RunTrace — Causal DAG per pipeline execution
 *
 * Every pipeline run produces a single queryable trace object.
 * Each node represents a DECISION (not a log entry) — a point where the
 * system chose between alternatives or enforced a constraint.
 *
 * Causal chain:
 *   INTENT_GATE → PLAN → SCAFFOLD → CODE → VERIFY
 *
 * Decision node ID format (deterministic, stable across retries):
 *   {run_id_8chars}-{phase_lower}-{decision_type}-{seq:03d}
 *   e.g. "abc12345-intent_gate-intent_classification-001"
 *
 * Integrity check (runs at end of every pipeline execution):
 *   1. Root node exists (exactly one node with no parent)
 *   2. All parent references point to existing nodes
 *   3. No orphan decisions (non-terminal nodes with no children)
 *   If check fails → pipeline_runs.non_explainable = true
 *
 * All writes are non-fatal — trace failures never block the pipeline.
 */

class RunTrace {
  /**
   * @param {import('pg').Pool} pool
   */
  constructor(pool) {
    this.pool = pool;
    // Per-run sequence counters: runId → Map(phase+decisionType → count)
    this._seqCounters = new Map();
    // Per-run last node ID: runId → nodeId (auto-tracked parent for next node)
    this._lastNodeIds = new Map();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Emit a decision node into the causal DAG.
   * Non-fatal: logs warning on failure and returns null.
   *
   * @param {string} runId
   * @param {string} phase
   *   One of: 'INTENT_GATE', 'PLAN', 'SCAFFOLD', 'CODE', 'SAVE', 'VERIFY'
   * @param {string} decisionType
   *   E.g. 'intent_classification', 'framework_selection', 'file_structure',
   *        'constraint_enforcement', 'verify_check'
   * @param {string} chosen
   *   What was selected (human-readable)
   * @param {object} [opts]
   * @param {string[]} [opts.alternatives]   - Alternatives that were considered
   * @param {string[]} [opts.rejectionReasons] - Why alternatives were rejected
   * @param {string[]} [opts.constraintRefs] - CCO constraint IDs that influenced this
   * @param {string|null} [opts.parentNodeId] - Override auto-detected parent (pass null for root)
   * @param {boolean} [opts.isTerminal]      - True if this node is a final decision (no children expected)
   * @returns {Promise<string|null>} The trace_node_id of the inserted row, or null on failure
   */
  async emitNode(runId, phase, decisionType, chosen, opts = {}) {
    const {
      alternatives     = [],
      rejectionReasons = [],
      constraintRefs   = [],
      parentNodeId     = undefined,   // undefined = use auto-parent; null = explicit root
      isTerminal       = false,
    } = opts;

    try {
      const nodeId = this._makeNodeId(runId, phase, decisionType);

      // Auto-detect parent: use override if provided (including explicit null for root),
      // otherwise fall back to last emitted node for this run.
      const resolvedParent = (parentNodeId !== undefined)
        ? parentNodeId
        : (this._lastNodeIds.get(runId) ?? null);

      await this.pool.query(
        `INSERT INTO trace_nodes
          (trace_node_id, parent_node_id, run_id, phase, decision_type, chosen,
           alternatives, rejection_reasons, constraint_refs, is_terminal, timestamp)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
         ON CONFLICT (trace_node_id) DO NOTHING`,
        [
          nodeId,
          resolvedParent,
          runId,
          phase,
          decisionType,
          String(chosen),
          JSON.stringify(alternatives),
          JSON.stringify(rejectionReasons),
          JSON.stringify(constraintRefs),
          isTerminal,
        ]
      );

      this._lastNodeIds.set(runId, nodeId);
      return nodeId;
    } catch (err) {
      console.warn(
        `[RunTrace] emitNode ${phase}/${decisionType} for run ${runId.slice(0, 8)} failed (non-fatal):`,
        err.message
      );
      return null;
    }
  }

  /**
   * Emit all decision nodes for the INTENT_GATE phase.
   * Extracts decisions from the frozen Constraint Contract Object (CCO).
   *
   * Nodes emitted:
   *   1. intent_classification  — which intent class was chosen and alternatives from entropy model
   *   2. constraint_contract_generation — which task_type and constraint set was produced
   *   3. complexity_budget_assignment  — which budget level was assigned
   *
   * @param {string} runId
   * @param {object} cco - Frozen Constraint Contract Object from classify()
   * @returns {Promise<void>}
   */
  async emitIntentGateNodes(runId, cco) {
    try {
      // Build constraint refs from the CCO constraints object (keys become IDs)
      const constraintRefs = this._extractConstraintRefs(cco);

      // ── Node 1: Intent Classification ──────────────────────────────────────
      // Extract alternatives from Phase 4 entropy candidates (if available)
      const candidates   = cco._candidates || [];
      const alternatives = candidates
        .filter(c => c.intent_class !== cco.intent_class)
        .map(c => `${c.intent_class} (p=${(c.probability || 0).toFixed(3)})`);

      const rejectionReasons = cco._entropy != null
        ? [`entropy=${cco._entropy.toFixed(4)} — highest-probability class selected`]
        : [];

      await this.emitNode(
        runId, 'INTENT_GATE', 'intent_classification',
        cco.intent_class,
        {
          alternatives,
          rejectionReasons,
          constraintRefs: [], // no CCO constraints yet at classification time
          parentNodeId: null, // root node
        }
      );

      // ── Node 2: Constraint Contract Generation ─────────────────────────────
      const taskDesc = `task_type=${cco.task_type}, constraints=[${constraintRefs.join(', ')}]`;
      await this.emitNode(
        runId, 'INTENT_GATE', 'constraint_contract_generation',
        taskDesc,
        {
          alternatives: [],
          rejectionReasons: cco._scope_locked
            ? [`Scope lock enforced — full_product prohibited during MVP validation`]
            : [],
          constraintRefs,
        }
      );

      // ── Node 3: Complexity Budget Assignment ───────────────────────────────
      const allBudgets    = ['low', 'medium', 'high'];
      const otherBudgets  = allBudgets.filter(b => b !== cco.complexity_budget);
      await this.emitNode(
        runId, 'INTENT_GATE', 'complexity_budget_assignment',
        cco.complexity_budget || 'unknown',
        {
          alternatives: otherBudgets,
          rejectionReasons: [],
          constraintRefs,
        }
      );
    } catch (err) {
      console.warn(`[RunTrace] emitIntentGateNodes failed (non-fatal):`, err.message);
    }
  }

  /**
   * Emit decision nodes for the PLAN phase.
   *
   * @param {string} runId
   * @param {object} planOutput - Validated PLAN stage output
   * @param {object} cco        - Constraint Contract Object (for constraint_refs)
   * @returns {Promise<void>}
   */
  async emitPlanNodes(runId, planOutput, cco) {
    try {
      const constraintRefs = this._extractConstraintRefs(cco);
      const subtasks       = planOutput?.subtasks || [];
      const included       = subtasks.map(t => t.title || t.id).join(', ') || 'unknown';
      const complexity     = planOutput?.estimatedComplexity || 'unknown';

      await this.emitNode(
        runId, 'PLAN', 'scope_decision',
        `${subtasks.length} subtasks (complexity=${complexity}): ${included}`,
        {
          alternatives: [],
          rejectionReasons: constraintRefs.length > 0
            ? [`Scope bounded by CCO constraints: ${constraintRefs.join(', ')}`]
            : [],
          constraintRefs,
        }
      );

      // If soft expansion was used, emit an expansion decision node
      if (planOutput?.expansion_justifications && planOutput.expansion_justifications.length > 0) {
        const justifications = planOutput.expansion_justifications;
        await this.emitNode(
          runId, 'PLAN', 'soft_expansion_decision',
          `Expanded into: ${justifications.map(j => j.capability).join(', ')}`,
          {
            alternatives: [`Stay within base_class=${cco?.base_class || 'unknown'}`],
            rejectionReasons: justifications.map(j => j.reason || ''),
            constraintRefs,
          }
        );
      }
    } catch (err) {
      console.warn(`[RunTrace] emitPlanNodes failed (non-fatal):`, err.message);
    }
  }

  /**
   * Emit decision nodes for the SCAFFOLD phase.
   *
   * @param {string} runId
   * @param {object} scaffoldOutput - Validated SCAFFOLD stage output
   * @param {object} cco            - Constraint Contract Object
   * @returns {Promise<void>}
   */
  async emitScaffoldNodes(runId, scaffoldOutput, cco) {
    try {
      const constraintRefs = this._extractConstraintRefs(cco);
      const techStack      = (scaffoldOutput?.techStack || []).join(', ') || 'unknown';
      const files          = scaffoldOutput?.files || [];
      const fileCount      = files.length;
      const entry          = scaffoldOutput?.constraints?.entry || 'unknown';

      // ── Node 1: Framework / tech-stack selection ───────────────────────────
      await this.emitNode(
        runId, 'SCAFFOLD', 'framework_selection',
        techStack,
        {
          alternatives: [],
          rejectionReasons: constraintRefs.length > 0
            ? constraintRefs.map(r => `Constraint ${r} enforced`)
            : [],
          constraintRefs,
        }
      );

      // ── Node 2: File structure decision ────────────────────────────────────
      const topLevelFiles = files
        .filter(f => !f.path?.includes('/'))
        .map(f => f.path)
        .join(', ') || `${fileCount} files`;

      await this.emitNode(
        runId, 'SCAFFOLD', 'file_structure',
        `entry=${entry}, files=[${topLevelFiles}]`,
        {
          alternatives: [],
          rejectionReasons: constraintRefs.length > 0
            ? [`Schema routed by intent_class=${cco?.intent_class}`]
            : [],
          constraintRefs,
        }
      );
    } catch (err) {
      console.warn(`[RunTrace] emitScaffoldNodes failed (non-fatal):`, err.message);
    }
  }

  /**
   * Emit decision nodes for the CODE phase.
   *
   * @param {string} runId
   * @param {object} codeOutput - Validated CODE stage output
   * @param {object} cco        - Constraint Contract Object
   * @returns {Promise<void>}
   */
  async emitCodeNodes(runId, codeOutput, cco) {
    try {
      const constraintRefs = this._extractConstraintRefs(cco);
      const fileCount      = Object.keys(codeOutput?.files || {}).length;
      const entryPoint     = codeOutput?.entryPoint || 'unknown';
      const totalLines     = codeOutput?.totalLines || 0;

      await this.emitNode(
        runId, 'CODE', 'implementation_strategy',
        `entry=${entryPoint}, ${fileCount} files, ${totalLines} lines`,
        {
          alternatives: [],
          rejectionReasons: constraintRefs.length > 0
            ? [`Implementation bounded by scaffold manifest and CCO (${constraintRefs.join(', ')})`]
            : [],
          constraintRefs,
        }
      );
    } catch (err) {
      console.warn(`[RunTrace] emitCodeNodes failed (non-fatal):`, err.message);
    }
  }

  /**
   * Emit decision nodes for the VERIFY phase.
   * Each check gets its own terminal node.
   *
   * @param {string} runId
   * @param {object} verifyOutput - Validated VERIFY stage output
   * @param {object} cco          - Constraint Contract Object
   * @returns {Promise<void>}
   */
  async emitVerifyNodes(runId, verifyOutput, cco) {
    try {
      const constraintRefs = this._extractConstraintRefs(cco);
      const checks         = verifyOutput?.checks || [];

      if (checks.length === 0) {
        // Emit a single terminal node for the overall verify result
        await this.emitNode(
          runId, 'VERIFY', 'verification_result',
          verifyOutput?.passed ? 'PASSED' : 'FAILED',
          {
            alternatives: [],
            rejectionReasons: verifyOutput?.errors || [],
            constraintRefs,
            isTerminal: true,
          }
        );
        return;
      }

      // Emit one node per check (each is terminal — these are the leaf decisions)
      for (let i = 0; i < checks.length; i++) {
        const check    = checks[i];
        const checkName = (check.name || `check_${i + 1}`)
          .toLowerCase()
          .replace(/\s+/g, '_');

        await this.emitNode(
          runId, 'VERIFY', `verify_${checkName}`,
          check.passed ? 'PASSED' : 'FAILED',
          {
            alternatives: ['PASSED', 'FAILED'].filter(r => r !== (check.passed ? 'PASSED' : 'FAILED')),
            rejectionReasons: check.passed ? [] : [check.message || check.error || 'Check failed'],
            constraintRefs,
            isTerminal: i === checks.length - 1, // last check is terminal
          }
        );
      }
    } catch (err) {
      console.warn(`[RunTrace] emitVerifyNodes failed (non-fatal):`, err.message);
    }
  }

  /**
   * Run integrity check at the end of a completed pipeline run.
   *
   * Rules:
   *   1. Exactly one root node (no parent)
   *   2. All parent_node_id references point to existing nodes
   *   3. No orphan nodes (non-terminal leaf nodes with no children)
   *
   * On failure: sets pipeline_runs.non_explainable = true (non-fatal).
   *
   * @param {string} runId
   * @returns {Promise<{ passed: boolean, violations: string[], nodeCount: number }>}
   */
  async checkIntegrity(runId) {
    const violations = [];
    let nodeCount    = 0;

    try {
      const { rows } = await this.pool.query(
        `SELECT trace_node_id, parent_node_id, phase, decision_type, is_terminal
         FROM trace_nodes
         WHERE run_id = $1
         ORDER BY timestamp ASC`,
        [runId]
      );

      nodeCount = rows.length;

      if (nodeCount === 0) {
        violations.push('NO_TRACE_NODES: No decision nodes emitted for this run');
      } else {
        const nodeIds   = new Set(rows.map(r => r.trace_node_id));
        const childIds  = new Set(rows.filter(r => r.parent_node_id !== null).map(r => r.trace_node_id));
        const parentRef = new Set(rows.map(r => r.parent_node_id).filter(Boolean));

        // Rule 1: Exactly one root node
        const roots = rows.filter(r => !r.parent_node_id);
        if (roots.length === 0) {
          violations.push('NO_ROOT_NODE: All nodes have a parent — DAG has no root');
        } else if (roots.length > 1) {
          violations.push(
            `MULTIPLE_ROOTS: ${roots.length} root nodes found (${roots.map(r => r.trace_node_id).join(', ')}) — DAG must have exactly one root`
          );
        }

        // Rule 2: All parent references point to existing nodes
        for (const row of rows) {
          if (row.parent_node_id && !nodeIds.has(row.parent_node_id)) {
            violations.push(
              `DANGLING_PARENT: Node ${row.trace_node_id} references non-existent parent ${row.parent_node_id}`
            );
          }
        }

        // Rule 3: No orphan non-terminal leaf nodes
        const leafNodes = rows.filter(r => !parentRef.has(r.trace_node_id));
        const orphans   = leafNodes.filter(r => !r.is_terminal);
        for (const o of orphans) {
          violations.push(
            `ORPHAN_NODE: Non-terminal leaf ${o.trace_node_id} (${o.phase}/${o.decision_type}) has no children and is not marked terminal`
          );
        }
      }

      const passed = violations.length === 0;

      if (!passed) {
        try {
          await this.pool.query(
            `UPDATE pipeline_runs SET non_explainable = TRUE WHERE id = $1`,
            [runId]
          );
        } catch (updateErr) {
          console.warn(
            `[RunTrace] Failed to set non_explainable on run ${runId.slice(0, 8)} (non-fatal):`,
            updateErr.message
          );
        }
        console.warn(
          `[RunTrace] Integrity FAILED for run ${runId.slice(0, 8)}: ` +
          violations.join(' | ')
        );
      } else {
        console.log(`[RunTrace] Integrity OK for run ${runId.slice(0, 8)} (${nodeCount} nodes)`);
      }

      return { passed, violations, nodeCount };
    } catch (err) {
      console.error('[RunTrace] checkIntegrity error:', err.message);
      return { passed: false, violations: [`CHECK_ERROR: ${err.message}`], nodeCount };
    }
  }

  /**
   * Get the full causal DAG for a run as a structured object.
   *
   * @param {string} runId
   * @returns {Promise<object>}
   */
  async getDAG(runId) {
    try {
      const [nodesResult, runResult] = await Promise.all([
        this.pool.query(
          `SELECT trace_node_id, parent_node_id, phase, decision_type, chosen,
                  alternatives, rejection_reasons, constraint_refs, is_terminal, timestamp
           FROM trace_nodes
           WHERE run_id = $1
           ORDER BY timestamp ASC, trace_node_id ASC`,
          [runId]
        ),
        this.pool.query(
          `SELECT non_explainable FROM pipeline_runs WHERE id = $1`,
          [runId]
        ),
      ]);

      const nonExplainable = nodesResult.rows[0]
        ? (runResult.rows[0]?.non_explainable ?? false)
        : false;

      const nodes = nodesResult.rows.map(row => ({
        traceNodeId:      row.trace_node_id,
        parentNodeId:     row.parent_node_id,
        phase:            row.phase,
        decisionType:     row.decision_type,
        chosen:           row.chosen,
        alternatives:     this._parseJsonb(row.alternatives),
        rejectionReasons: this._parseJsonb(row.rejection_reasons),
        constraintRefs:   this._parseJsonb(row.constraint_refs),
        isTerminal:       row.is_terminal,
        timestamp:        row.timestamp,
      }));

      // Build edges from parent-child relationships
      const edges = nodes
        .filter(n => n.parentNodeId !== null)
        .map(n => ({ from: n.parentNodeId, to: n.traceNodeId }));

      return {
        runId,
        nodeCount: nodes.length,
        nonExplainable,
        nodes,
        edges,
      };
    } catch (err) {
      console.error('[RunTrace] getDAG error:', err.message);
      return { runId, nodeCount: 0, nonExplainable: false, nodes: [], edges: [], error: err.message };
    }
  }

  /**
   * Release in-memory counters for a completed or failed run.
   * Call this after checkIntegrity() or after a failed run to avoid memory leaks.
   *
   * @param {string} runId
   */
  clearRun(runId) {
    this._seqCounters.delete(runId);
    this._lastNodeIds.delete(runId);
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Generate a deterministic node ID.
   * Format: {run_id_8chars}-{phase_lower}-{decision_type}-{seq:03d}
   * Sequence is scoped to (runId, phase, decisionType) so retries get the same IDs.
   *
   * @param {string} runId
   * @param {string} phase
   * @param {string} decisionType
   * @returns {string}
   */
  _makeNodeId(runId, phase, decisionType) {
    const key = `${phase}::${decisionType}`;
    if (!this._seqCounters.has(runId)) {
      this._seqCounters.set(runId, new Map());
    }
    const runMap = this._seqCounters.get(runId);
    const seq    = (runMap.get(key) || 0) + 1;
    runMap.set(key, seq);

    return `${runId.slice(0, 8)}-${phase.toLowerCase()}-${decisionType}-${String(seq).padStart(3, '0')}`;
  }

  /**
   * Extract constraint ref IDs from a CCO.
   * Returns array of strings like ["no_database", "framework", "frontend_only"].
   *
   * @param {object|null} cco
   * @returns {string[]}
   */
  _extractConstraintRefs(cco) {
    if (!cco || !cco.constraints) return [];
    try {
      return Object.keys(cco.constraints).filter(k => {
        const v = cco.constraints[k];
        return v !== null && v !== undefined && v !== false;
      });
    } catch {
      return [];
    }
  }

  /**
   * Safely parse a JSONB column value (may already be parsed by the pg driver).
   *
   * @param {string|any[]|null} value
   * @returns {any[]}
   */
  _parseJsonb(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    try {
      return JSON.parse(value);
    } catch {
      return [];
    }
  }
}

module.exports = { RunTrace };
