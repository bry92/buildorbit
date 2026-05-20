/**
 * Product Context Utility
 *
 * Formats structured product context into a prompt block that agents
 * inject into their system prompts. This ensures the AI generates content
 * that accurately describes the actual product, not a hallucination.
 *
 * Context shape:
 *   {
 *     company:         string  - Company name
 *     product:         string  - Product name / one-liner
 *     description:     string  - What the product actually does
 *     coreFeatures:    string  - Key features / capabilities
 *     targetAudience:  string  - Who the product is for
 *     keyDifferentiator: string - What makes it unique
 *     brandVoice:      string  - Tone, terminology, positioning
 *     pricing:         string  - Pricing tiers / model (optional)
 *     extra:           string  - Any additional context (optional)
 *   }
 */

/**
 * Format a product context object into a structured prompt block.
 *
 * @param {object|null} ctx - Product context object (or null)
 * @returns {string|null} Formatted context block, or null if no context
 */
function formatProductContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return null;

  // Check for standard product fields OR source repo fields
  const hasContent = ctx.company || ctx.product || ctx.description || ctx._sourceRepo;
  if (!hasContent) return null;

  // Source repo mode: format as existing codebase context
  if (ctx._sourceRepo) {
    const lines = ['=== EXISTING CODEBASE CONTEXT ==='];
    lines.push('');
    lines.push('You are EXTENDING an existing repository. The code below is the current state.');
    lines.push('You MUST build upon this codebase — do NOT generate a new app from scratch.');
    lines.push('');
    lines.push(ctx._sourceRepo);
    if (ctx._sourceRepoFullName) {
      lines.push('');
      lines.push(`Repository: ${ctx._sourceRepoFullName}`);
    }
    lines.push('');
    lines.push('=== END EXISTING CODEBASE CONTEXT ===');
    return lines.join('\n');
  }

  const lines = ['=== PRODUCT CONTEXT ==='];

  if (ctx.company)             lines.push(`Company: ${ctx.company}`);
  if (ctx.product)             lines.push(`Product: ${ctx.product}`);
  if (ctx.description)         lines.push(`Description: ${ctx.description}`);
  if (ctx.coreFeatures)        lines.push(`Core features: ${ctx.coreFeatures}`);
  if (ctx.targetAudience)      lines.push(`Target audience: ${ctx.targetAudience}`);
  if (ctx.keyDifferentiator)   lines.push(`Key differentiator: ${ctx.keyDifferentiator}`);
  if (ctx.brandVoice)          lines.push(`Brand voice: ${ctx.brandVoice}`);
  if (ctx.pricing)             lines.push(`Pricing: ${ctx.pricing}`);
  if (ctx.extra)               lines.push(ctx.extra);

  lines.push('=== END PRODUCT CONTEXT ===');

  return lines.join('\n');
}

/**
 * Load product context from the PRODUCT_CONTEXT_JSON environment variable.
 * Used as a global fallback when no per-run context is provided.
 *
 * @returns {object|null} Parsed product context object, or null
 */
function loadProductContextFromEnv() {
  const raw = process.env.PRODUCT_CONTEXT_JSON;
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch (_) {
    console.warn('[ProductContext] Failed to parse PRODUCT_CONTEXT_JSON env var');
    return null;
  }
}

/**
 * Build the prompt instruction block for agents.
 *
 * When context exists: returns the context block + instruction to use it.
 * When context is missing: returns a fallback instruction to use placeholders.
 *
 * @param {string|null} formattedContext - Pre-formatted context block (from formatProductContext)
 * @returns {string} Instruction block to prepend to agent system prompts
 */
function buildContextInstruction(formattedContext) {
  if (formattedContext && formattedContext.includes('EXISTING CODEBASE CONTEXT')) {
    // Source repo mode: instruct agents to extend, not replace
    return `${formattedContext}

CRITICAL — BUILD FROM EXISTING REPO MODE:
- You are improving/extending an EXISTING codebase shown above
- You MUST preserve the existing project structure, dependencies, and patterns
- Generate files that ADD to or MODIFY the existing codebase — never start from scratch
- Respect the existing tech stack (framework, language, build tools) detected in the repo
- Your output files must integrate with the existing file structure
- NEVER generate a generic 3-file boilerplate app (index.html + styles.css + app.js) when extending an existing repo
- If the user's prompt asks for a new feature, add it as new files/modifications that fit the existing architecture`;
  }

  if (formattedContext) {
    return `${formattedContext}

CRITICAL: You MUST use the product context above for ALL content generation.
- Company name, product name, and descriptions must come from the context above
- Do NOT invent features, pricing, testimonials, or company details
- If a detail is not in the context, use a clearly marked placeholder like [SPECIFY: ...]
- The product described above is the ONLY product you are building — do not substitute another`;
  }

  return `IMPORTANT: No structured product context was provided. You MUST extract ALL business details directly from the user's prompt below.
- Business/product name: find the name in the prompt (look for "called X", "named X", or the proper noun). Use it in the page title, headings, and meta tags. NEVER substitute a generic name.
- Requested sections: if the prompt mentions pricing, testimonials, FAQ, about, team, features, gallery, menu, schedule, etc. — generate each as a real content section with plausible content for that business type.
- CTAs: if the prompt specifies a CTA (e.g. "booking CTA", "free trial CTA", "signup CTA"), generate button text that matches (e.g. "Book Now", "Start Free Trial", "Sign Up"). NEVER use generic "Get Started" when a specific CTA is requested.
- Generate realistic placeholder content appropriate to the business type (e.g. pet grooming → grooming packages with prices, happy pet owner testimonials). Content should feel real and specific to the domain, not generic lorem ipsum.
- If you truly cannot determine a detail from the prompt, use a clearly marked placeholder like [SPECIFY: pricing tiers]`;
}

module.exports = { formatProductContext, loadProductContextFromEnv, buildContextInstruction };
