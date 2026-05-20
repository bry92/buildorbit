/**
 * Scaffold Schema Registry
 *
 * Maps intent_class → scaffold schema template.
 * Selected BEFORE any scaffold generation — not after.
 *
 * Each schema defines the ONLY valid metadata for that intent class:
 *   - entry:      The entry point file (what runs first)
 *   - techStack:  Technology dependencies (never empty)
 *   - server:     Whether a server exists
 *   - directories: Expected top-level directories
 *   - validation: Custom validation rules per schema
 *
 * This makes scaffold metadata polymorphic by intent class.
 * A static_surface build is physically incapable of producing entry: 'server.js'.
 */

const SCAFFOLD_SCHEMAS = {
  // ── Static Surface ─────────────────────────────────────────────────────────
  // Landing pages, portfolios, marketing sites — pure HTML/CSS/JS.
  // No server, no database, no backend.
  // Tailwind CSS is loaded via CDN — no build step required.
  static_surface: {
    entry: 'index.html',
    techStack: ['html', 'css', 'js', 'tailwindcss-cdn'],
    server: false,
    directories: [],
    // Validation: these fields are IMPOSSIBLE in this schema
    prohibited: {
      entry: ['server.js', 'index.js', 'app.js'],
      techStack: ['express', 'pg', 'jsonwebtoken', 'bcrypt', 'node'],
    },
  },

  // ── Light App ──────────────────────────────────────────────────────────────
  // Forms, waitlists, calculators — optional lightweight server.
  // Entry is index.html (frontend-first), server is a supporting role.
  // Tailwind CSS is loaded via CDN — no build step required.
  // Uses in-memory storage — no pg/database/migrations for light apps.
  // Intent Gate allowed_artifacts: html, css, js, server.js, routes/api.js, package.json
  light_app: {
    entry: 'index.html',
    techStack: ['express', 'tailwindcss-cdn'],
    server: true,
    directories: ['routes'],
    prohibited: {
      entry: [],
      techStack: ['jsonwebtoken', 'bcrypt', 'pg'],
    },
  },

  // ── Full Product (PRODUCT_SYSTEM) ─────────────────────────────────────────
  // SaaS, platforms, multi-tenant dashboards — full backend + auth.
  // Entry is server.js (backend-first), everything enabled.
  // Database: dual-driver (pg for postgres:// URLs on Render/Neon, better-sqlite3 fallback for local dev).
  // Tailwind CSS is loaded via CDN — no build step required.
  //
  // required_files: files that MUST appear in every full_product scaffold manifest.
  // These are enforced by validateScaffoldManifest() in stage-contracts.js.
  full_product: {
    entry: 'server.js',
    techStack: ['express', 'pg', 'better-sqlite3', 'jsonwebtoken', 'bcrypt', 'dotenv', 'tailwindcss-cdn'],
    server: true,
    directories: ['routes', 'models', 'middleware', 'db', 'migrations', 'public'],
    required_files: ['server.js', 'package.json', '.env.example'],
    prohibited: {
      entry: [],
      techStack: ['mysql', 'mongodb'],
    },
  },
};

/**
 * Get the scaffold schema for an intent class.
 *
 * @param {string} intentClass - 'static_surface' | 'light_app' | 'full_product' (PRODUCT_SYSTEM)
 * @returns {object} Schema template (deep copy)
 */
function getScaffoldSchema(intentClass) {
  const schema = SCAFFOLD_SCHEMAS[intentClass];
  if (!schema) {
    // Default to light_app (safe middle ground, matches intent-gate default)
    console.warn(`[ScaffoldSchema] Unknown intent_class "${intentClass}" — defaulting to light_app`);
    return JSON.parse(JSON.stringify(SCAFFOLD_SCHEMAS.light_app));
  }
  return JSON.parse(JSON.stringify(schema));
}

/**
 * Validate scaffold constraints against the selected schema.
 * This is compile-time prevention — not runtime rejection.
 *
 * @param {object} constraints - { entry, techStack, hasServer, ... }
 * @param {string} intentClass - The intent class that selected the schema
 * @returns {{ valid: boolean, violations: string[] }}
 */
function validateConstraintsAgainstSchema(constraints, intentClass) {
  const schema = SCAFFOLD_SCHEMAS[intentClass];
  if (!schema) return { valid: true, violations: [] };

  const violations = [];

  // Entry point must match schema
  if (constraints.entry !== schema.entry) {
    violations.push(
      `Schema "${intentClass}" requires entry="${schema.entry}" but got "${constraints.entry}"`
    );
  }

  // Entry point must not be in prohibited list
  if (schema.prohibited.entry.includes(constraints.entry)) {
    violations.push(
      `Entry "${constraints.entry}" is prohibited for schema "${intentClass}"`
    );
  }

  // techStack must not contain prohibited items
  if (Array.isArray(constraints.techStack)) {
    const prohibited = constraints.techStack.filter(t =>
      schema.prohibited.techStack.includes(t)
    );
    if (prohibited.length > 0) {
      violations.push(
        `techStack contains prohibited items for "${intentClass}": ${prohibited.join(', ')}`
      );
    }
  }

  // Server flag must match schema
  if (schema.server === false && constraints.hasServer === true) {
    violations.push(
      `Schema "${intentClass}" disallows server but hasServer=true`
    );
  }

  return {
    valid: violations.length === 0,
    violations,
  };
}

module.exports = {
  SCAFFOLD_SCHEMAS,
  getScaffoldSchema,
  validateConstraintsAgainstSchema,
};
