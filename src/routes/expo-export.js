/**
 * Expo Export Routes
 *
 * GET  /api/pipeline/:runId/code-files/download  → ZIP of raw generated files (existing contract)
 * POST /api/builds/:runId/export/expo            → Expo React Native project ZIP
 *
 * Owns: web-to-RN conversion logic, ZIP generation for both export types.
 * Does NOT own: code generation (builder-agent), artifact storage (artifactStore), auth (server.js).
 */

'use strict';

const express  = require('express');
const archiver = require('archiver');

// ── Expo project template helpers ─────────────────────────────────────────────

/**
 * Derive a safe app name from the build prompt.
 * Returns a PascalCase string, max 32 chars.
 */
function deriveAppName(prompt) {
  if (!prompt || typeof prompt !== 'string') return 'BuildOrbitApp';
  const words = prompt
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  if (words.length === 0) return 'BuildOrbitApp';
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join('').slice(0, 32) || 'BuildOrbitApp';
}

/**
 * Derive a slug for package.json "name" field (lowercase, hyphens).
 */
function deriveSlug(prompt) {
  if (!prompt || typeof prompt !== 'string') return 'buildorbit-app';
  const words = prompt
    .replace(/[^a-zA-Z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 4);
  if (words.length === 0) return 'buildorbit-app';
  return words.map(w => w.toLowerCase()).join('-').slice(0, 40) || 'buildorbit-app';
}

// ── Web → React Native conversion ────────────────────────────────────────────

/**
 * Convert a single HTML/JSX file's content to React Native JSX.
 * Best-effort: tags, basic onClick→onPress, simple Tailwind→StyleSheet.
 * Unconvertible elements get TODO comments, not crashes.
 */
function convertWebToRN(content, filename) {
  if (!content || typeof content !== 'string') return '';

  let out = content;

  // Strip HTML boilerplate (doctype, html, head, body wrappers) if present
  out = out.replace(/<!DOCTYPE[^>]*>/gi, '');
  out = out.replace(/<html[^>]*>[\s\S]*?<body[^>]*>/i, '');
  out = out.replace(/<\/body>[\s\S]*?<\/html>/i, '');
  out = out.replace(/<head>[\s\S]*?<\/head>/gi, '');
  out = out.replace(/<link[^>]*>/gi, '');
  out = out.replace(/<meta[^>]*>/gi, '');
  out = out.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '// TODO: wire up your logic here');

  // SVG → TODO comment
  out = out.replace(/<svg[\s\S]*?<\/svg>/gi, '{/* TODO: use expo-svg here */}');

  // Element tag conversions
  const tagMap = [
    [/<div(\s)/gi,      '<View$1'],
    [/<\/div>/gi,       '</View>'],
    [/<section(\s|>)/gi,'<View$1'],
    [/<\/section>/gi,   '</View>'],
    [/<article(\s|>)/gi,'<View$1'],
    [/<\/article>/gi,   '</View>'],
    [/<header(\s|>)/gi, '<View$1'],
    [/<\/header>/gi,    '</View>'],
    [/<footer(\s|>)/gi, '<View$1'],
    [/<\/footer>/gi,    '</View>'],
    [/<main(\s|>)/gi,   '<View$1'],
    [/<\/main>/gi,      '</View>'],
    [/<nav(\s|>)/gi,    '<View$1'],
    [/<\/nav>/gi,       '</View>'],
    [/<aside(\s|>)/gi,  '<View$1'],
    [/<\/aside>/gi,     '</View>'],
    [/<span(\s)/gi,     '<Text$1'],
    [/<\/span>/gi,      '</Text>'],
    [/<p(\s|>)/gi,      '<Text$1'],
    [/<\/p>/gi,         '</Text>'],
    [/<h[1-6](\s)/gi,   '<Text$1'],
    [/<\/h[1-6]>/gi,    '</Text>'],
    [/<label(\s)/gi,    '<Text$1'],
    [/<\/label>/gi,     '</Text>'],
    [/<strong(\s|>)/gi, '<Text$1'],
    [/<\/strong>/gi,    '</Text>'],
    [/<em(\s|>)/gi,     '<Text$1'],
    [/<\/em>/gi,        '</Text>'],
    [/<img(\s)/gi,      '<Image$1'],
    [/<img\s*\/>/gi,    '<Image />'],
    [/<input(\s)/gi,    '<TextInput$1'],
    [/<textarea(\s|>)/gi,'<TextInput$1'],
    [/<\/textarea>/gi,  '</TextInput>'],
    [/<button(\s)/gi,   '<Pressable$1'],
    [/<\/button>/gi,    '</Pressable>'],
    [/<a(\s)/gi,        '<Pressable$1'],
    [/<\/a>/gi,         '</Pressable>'],
    [/<ul(\s|>)/gi,     '<View$1'],
    [/<\/ul>/gi,        '</View>'],
    [/<ol(\s|>)/gi,     '<View$1'],
    [/<\/ol>/gi,        '</View>'],
    [/<li(\s|>)/gi,     '<View$1'],
    [/<\/li>/gi,        '</View>'],
    [/<select(\s|>)/gi, '{/* TODO: use @react-native-picker/picker */}'],
    [/<\/select>/gi,    ''],
    [/<option[^>]*>[\s\S]*?<\/option>/gi, ''],
    [/<table(\s|>)/gi,  '<View$1'],
    [/<\/table>/gi,     '</View>'],
    [/<tr(\s|>)/gi,     '<View$1'],
    [/<\/tr>/gi,        '</View>'],
    [/<td(\s|>)/gi,     '<View$1'],
    [/<\/td>/gi,        '</View>'],
    [/<th(\s|>)/gi,     '<View$1'],
    [/<\/th>/gi,        '</View>'],
    [/<thead(\s|>)/gi,  '<View$1'],
    [/<\/thead>/gi,     '</View>'],
    [/<tbody(\s|>)/gi,  '<View$1'],
    [/<\/tbody>/gi,     '</View>'],
    [/<form(\s|>)/gi,   '<View$1'],
    [/<\/form>/gi,      '</View>'],
  ];

  for (const [from, to] of tagMap) {
    out = out.replace(from, to);
  }

  // Event handler conversions
  out = out.replace(/onClick=/g, 'onPress=');
  out = out.replace(/onChange=/g, 'onChangeText=');
  out = out.replace(/onSubmit=/g, 'onPress=');
  out = out.replace(/onMouseEnter=/g, '/* onMouseEnter not supported */ ');
  out = out.replace(/onMouseLeave=/g, '/* onMouseLeave not supported */ ');

  // href → onPress with TODO
  out = out.replace(/href="([^"]+)"/g, (match, url) => {
    if (url.startsWith('/')) {
      return `onPress={() => router.push('${url}')}`;
    }
    return `onPress={() => { /* TODO: Linking.openURL('${url}') */ }}`;
  });

  // src → source for Image
  out = out.replace(/<Image([^>]*)src="([^"]+)"([^>]*)>/g, '<Image$1source={{uri:"$2"}}$3>');
  out = out.replace(/<Image([^>]*)src=\{([^}]+)\}([^>]*)>/g, '<Image$1source={$2}$3>');

  // placeholder → placeholder (TextInput already supports this)

  // CSS animations → TODO comment
  out = out.replace(/animation[-a-z]*:[^;}"']+[;}"']/gi, '/* TODO: use react-native-reanimated for animations */ ');

  // Convert className to style (basic Tailwind→StyleSheet mapping)
  out = out.replace(/className="([^"]*)"/g, (match, classes) => {
    const style = tailwindToRNStyle(classes);
    if (Object.keys(style).length > 0) {
      const inline = JSON.stringify(style).replace(/"([^"]+)":/g, '$1:');
      return `style={${inline}}`;
    }
    return `style={{}} /* ${classes} */`;
  });

  return out.trim();
}

/**
 * Convert a subset of Tailwind utility classes to React Native StyleSheet properties.
 * Only common layout, spacing, color, typography classes — skips unknowns silently.
 */
function tailwindToRNStyle(classes) {
  const style = {};
  const colorMap = {
    'white': '#ffffff', 'black': '#000000',
    'gray-50':'#f9fafb','gray-100':'#f3f4f6','gray-200':'#e5e7eb','gray-300':'#d1d5db',
    'gray-400':'#9ca3af','gray-500':'#6b7280','gray-600':'#4b5563','gray-700':'#374151',
    'gray-800':'#1f2937','gray-900':'#111827',
    'blue-50':'#eff6ff','blue-100':'#dbeafe','blue-500':'#3b82f6','blue-600':'#2563eb','blue-700':'#1d4ed8',
    'green-50':'#f0fdf4','green-100':'#dcfce7','green-500':'#22c55e','green-600':'#16a34a',
    'red-50':'#fef2f2','red-500':'#ef4444','red-600':'#dc2626',
    'yellow-50':'#fefce8','yellow-500':'#eab308',
    'purple-500':'#a855f7','purple-600':'#9333ea',
    'indigo-500':'#6366f1','indigo-600':'#4f46e5',
    'pink-500':'#ec4899',
    'orange-500':'#f97316',
    'cyan-500':'#06b6d4',
    'teal-500':'#14b8a6',
  };

  const spacingMap = { '0':0,'1':4,'2':8,'3':12,'4':16,'5':20,'6':24,'7':28,'8':32,'9':36,'10':40,'12':48,'14':56,'16':64,'20':80,'24':96,'28':112,'32':128,'36':144,'40':160,'48':192,'56':224,'64':256 };
  const fontSizeMap = { 'xs':12,'sm':14,'base':16,'lg':18,'xl':20,'2xl':24,'3xl':30,'4xl':36,'5xl':48,'6xl':60 };
  const fontWeightMap = { 'thin':'100','light':'300','normal':'400','medium':'500','semibold':'600','bold':'700','extrabold':'800','black':'900' };

  const parts = classes.split(/\s+/).filter(Boolean);
  for (const cls of parts) {
    if (cls === 'flex')                        { style.display = 'flex'; }
    else if (cls === 'flex-row')               { style.flexDirection = 'row'; }
    else if (cls === 'flex-col')               { style.flexDirection = 'column'; }
    else if (cls === 'flex-wrap')              { style.flexWrap = 'wrap'; }
    else if (cls === 'flex-nowrap')            { style.flexWrap = 'nowrap'; }
    else if (cls.match(/^flex-(\d+)$/))        { style.flex = parseInt(cls.split('-')[1]); }
    else if (cls === 'items-start')            { style.alignItems = 'flex-start'; }
    else if (cls === 'items-center')           { style.alignItems = 'center'; }
    else if (cls === 'items-end')              { style.alignItems = 'flex-end'; }
    else if (cls === 'items-stretch')          { style.alignItems = 'stretch'; }
    else if (cls === 'justify-start')          { style.justifyContent = 'flex-start'; }
    else if (cls === 'justify-center')         { style.justifyContent = 'center'; }
    else if (cls === 'justify-end')            { style.justifyContent = 'flex-end'; }
    else if (cls === 'justify-between')        { style.justifyContent = 'space-between'; }
    else if (cls === 'justify-around')         { style.justifyContent = 'space-around'; }
    else if (cls === 'absolute')               { style.position = 'absolute'; }
    else if (cls === 'relative')               { style.position = 'relative'; }
    else if (cls === 'hidden')                 { style.display = 'none'; }
    else if (cls === 'overflow-hidden')        { style.overflow = 'hidden'; }
    else if (cls === 'rounded')                { style.borderRadius = 4; }
    else if (cls === 'rounded-full')           { style.borderRadius = 9999; }
    else if (cls === 'rounded-lg')             { style.borderRadius = 8; }
    else if (cls === 'rounded-md')             { style.borderRadius = 6; }
    else if (cls === 'rounded-sm')             { style.borderRadius = 2; }
    else if (cls === 'rounded-xl')             { style.borderRadius = 12; }
    else if (cls === 'rounded-2xl')            { style.borderRadius = 16; }
    else if (cls === 'shadow')                 { style.shadowOpacity = 0.1; style.shadowRadius = 4; style.elevation = 2; }
    else if (cls === 'shadow-md')              { style.shadowOpacity = 0.15; style.shadowRadius = 8; style.elevation = 4; }
    else if (cls === 'shadow-lg')              { style.shadowOpacity = 0.2; style.shadowRadius = 12; style.elevation = 6; }
    else if (cls === 'w-full')                 { style.width = '100%'; }
    else if (cls === 'h-full')                 { style.height = '100%'; }
    else if (cls === 'w-screen')               { style.width = '100%'; }
    else if (cls === 'h-screen')               { style.flex = 1; }
    else if (cls === 'min-h-screen')           { style.flex = 1; }
    else if (cls === 'text-center')            { style.textAlign = 'center'; }
    else if (cls === 'text-left')              { style.textAlign = 'left'; }
    else if (cls === 'text-right')             { style.textAlign = 'right'; }
    else if (cls === 'uppercase')              { style.textTransform = 'uppercase'; }
    else if (cls === 'lowercase')              { style.textTransform = 'lowercase'; }
    else if (cls === 'capitalize')             { style.textTransform = 'capitalize'; }
    else if (cls === 'italic')                 { style.fontStyle = 'italic'; }
    else if (cls === 'underline')              { style.textDecorationLine = 'underline'; }
    else if (cls === 'line-through')           { style.textDecorationLine = 'line-through'; }
    else {
      // Spacing: p-, m-, px-, py-, pt-, pb-, pl-, pr-, mx-, my-, etc.
      const spacingMatch = cls.match(/^(p|m|pt|pb|pl|pr|px|py|mt|mb|ml|mr|mx|my|gap|space-x|space-y)-(\d+)$/);
      if (spacingMatch) {
        const [, prop, val] = spacingMatch;
        const px = spacingMap[val];
        if (px !== undefined) {
          const propMap = {
            p: ['padding'], m: ['margin'], px: ['paddingHorizontal'], py: ['paddingVertical'],
            pt: ['paddingTop'], pb: ['paddingBottom'], pl: ['paddingLeft'], pr: ['paddingRight'],
            mx: ['marginHorizontal'], my: ['marginVertical'],
            mt: ['marginTop'], mb: ['marginBottom'], ml: ['marginLeft'], mr: ['marginRight'],
            gap: ['gap'], 'space-x': ['columnGap'], 'space-y': ['rowGap'],
          };
          for (const key of (propMap[prop] || [])) style[key] = px;
        }
        continue;
      }
      // Width/height: w-N, h-N
      const dimMatch = cls.match(/^(w|h)-(\d+)$/);
      if (dimMatch) {
        const px = spacingMap[dimMatch[2]];
        if (px !== undefined) {
          if (dimMatch[1] === 'w') style.width = px;
          else style.height = px;
        }
        continue;
      }
      // Colors: text-, bg-, border-
      const colorMatch = cls.match(/^(text|bg|border)-(.+)$/);
      if (colorMatch) {
        const [, type, name] = colorMatch;
        const hex = colorMap[name];
        if (hex) {
          if (type === 'text')   style.color = hex;
          if (type === 'bg')     style.backgroundColor = hex;
          if (type === 'border') style.borderColor = hex;
        }
        continue;
      }
      // Font size: text-xs, text-sm, etc.
      const fsMatch = cls.match(/^text-(xs|sm|base|lg|[2-6]?xl)$/);
      if (fsMatch && fontSizeMap[fsMatch[1]]) {
        style.fontSize = fontSizeMap[fsMatch[1]];
        continue;
      }
      // Font weight: font-bold etc.
      const fwMatch = cls.match(/^font-(.+)$/);
      if (fwMatch && fontWeightMap[fwMatch[1]]) {
        style.fontWeight = fontWeightMap[fwMatch[1]];
        continue;
      }
      // Opacity: opacity-N
      const opMatch = cls.match(/^opacity-(\d+)$/);
      if (opMatch) {
        style.opacity = parseInt(opMatch[1]) / 100;
        continue;
      }
      // Border width: border, border-N
      const borderMatch = cls.match(/^border-(\d+)?$/);
      if (borderMatch) {
        style.borderWidth = borderMatch[1] ? parseInt(borderMatch[1]) : 1;
        continue;
      }
    }
  }
  return style;
}

/**
 * Determine if a file is a React/web component file.
 */
function isWebFile(filename) {
  return /\.(html|jsx|tsx|js|ts|css)$/.test(filename);
}

/**
 * Convert a web filename to an RN-friendly screen/component filename.
 * e.g. "dashboard.html" → "DashboardScreen.js"
 *      "components/Header.jsx" → "components/Header.js"
 */
function toRNFilename(filename) {
  const base = filename.replace(/\.(html|jsx|tsx|ts)$/, '');
  const parts = base.split('/');
  const name = parts[parts.length - 1];
  const capitalized = name.charAt(0).toUpperCase() + name.slice(1);

  if (filename.endsWith('.html')) {
    return parts.slice(0, -1).concat([capitalized + 'Screen.js']).join('/');
  }
  return parts.slice(0, -1).concat([capitalized + '.js']).join('/');
}

/**
 * Wrap converted content in a proper React Native component file.
 */
function wrapAsRNComponent(convertedContent, componentName, isScreen) {
  const rnImports = isScreen
    ? "import React from 'react';\nimport { View, Text, TextInput, Image, Pressable, ScrollView, StyleSheet } from 'react-native';\nimport { useRouter } from 'expo-router';"
    : "import React from 'react';\nimport { View, Text, TextInput, Image, Pressable, StyleSheet } from 'react-native';";

  const safeName = componentName.replace(/[^a-zA-Z0-9_]/g, '_');
  const routerLine = isScreen ? '\n  const router = useRouter();' : '';

  return `${rnImports}

export default function ${safeName}() {${routerLine}
  return (
    <ScrollView style={styles.container}>
${convertedContent.split('\n').map(l => '      ' + l).join('\n')}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#ffffff',
  },
});
`;
}

// ── Expo project file generators ─────────────────────────────────────────────

function generateAppJs(screens, appName) {
  const screenImports = screens.map((s, i) => `import Screen${i} from './screens/${s.rnFile}';`).join('\n');
  const tabScreens = screens.map((s, i) =>
    `  <Tab.Screen name="${s.name}" component={Screen${i}} />`
  ).join('\n');

  return `import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
${screenImports}

const Tab = createBottomTabNavigator();

export default function App() {
  return (
    <NavigationContainer>
      <Tab.Navigator>
${tabScreens}
      </Tab.Navigator>
    </NavigationContainer>
  );
}
`;
}

function generateSimpleAppJs(appName) {
  return `import React from 'react';
import { View, Text, StyleSheet } from 'react-native';

// Generated by BuildOrbit — wire up your screens here.
export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>${appName}</Text>
      <Text style={styles.sub}>Generated by BuildOrbit ⚡</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#fff' },
  title:     { fontSize: 28, fontWeight: '700', marginBottom: 8 },
  sub:       { fontSize: 16, color: '#6b7280' },
});
`;
}

function generateAppJson(appName, slug) {
  return JSON.stringify({
    expo: {
      name: appName,
      slug: slug,
      version: '1.0.0',
      orientation: 'portrait',
      icon: './assets/icon.png',
      userInterfaceStyle: 'light',
      splash: { image: './assets/splash.png', resizeMode: 'contain', backgroundColor: '#ffffff' },
      ios: { supportsTablet: true },
      android: { adaptiveIcon: { foregroundImage: './assets/adaptive-icon.png', backgroundColor: '#ffffff' } },
      web: { favicon: './assets/favicon.png' },
      sdkVersion: '52.0.0',
    }
  }, null, 2);
}

function generatePackageJson(appName, slug) {
  return JSON.stringify({
    name: slug,
    version: '1.0.0',
    main: 'App.js',
    scripts: {
      start: 'expo start',
      android: 'expo start --android',
      ios: 'expo start --ios',
      web: 'expo start --web',
    },
    dependencies: {
      expo: '~52.0.0',
      'expo-status-bar': '~2.0.0',
      'expo-router': '~4.0.0',
      react: '18.3.1',
      'react-native': '0.76.5',
      '@react-navigation/native': '^6.1.18',
      '@react-navigation/bottom-tabs': '^6.6.1',
      'react-native-screens': '~4.4.0',
      'react-native-safe-area-context': '4.12.0',
    },
    devDependencies: {
      '@babel/core': '^7.25.0',
    },
  }, null, 2);
}

function generateBabelConfig() {
  return `module.exports = function(api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
  };
};
`;
}

function generateReadme(appName, prompt) {
  return `# ${appName} — Generated by BuildOrbit

## Setup

\`\`\`bash
npm install
npx expo start
\`\`\`

## What's Inside

This Expo project was generated from your BuildOrbit web app build.
Components have been converted to React Native primitives.

**Original prompt:** ${prompt || 'Not available'}

## Notes

- Styling converted from Tailwind to StyleSheet (some manual tweaks may be needed)
- Backend API calls are stubbed — connect your own API
- Tested for Expo SDK 52+
- \`App.js\` is the entry point — update navigation structure as needed

## Running

\`\`\`bash
# Install Expo Go on your phone, then:
npx expo start

# Or run in a simulator:
npx expo start --ios
npx expo start --android
\`\`\`

---
*Generated by [BuildOrbit](https://buildorbit.polsia.app)*
`;
}

// ── Router factory ────────────────────────────────────────────────────────────

/**
 * @param {{ pool, artifactStore, pipeline, requireAuth }} deps
 * @returns {express.Router}
 */
function createExpoExportRouter({ pool, artifactStore, pipeline, requireAuth }) {
  const router = express.Router();

  const authMiddleware = requireAuth || ((req, res, next) => {
    if (!req.user?.userId) {
      return res.status(401).json({ success: false, message: 'Authentication required' });
    }
    next();
  });

  // ── Helper: load code artifact ───────────────────────────────────────────
  async function loadCodeArtifact(runId) {
    let artifact = await artifactStore.readArtifact(runId, 'code', 'code.json');
    if (!artifact || !artifact.files) {
      try {
        const { rows } = await pool.query(
          `SELECT code, prompt FROM pipeline_runs WHERE id = $1`,
          [runId]
        );
        if (rows[0]?.code) {
          artifact = typeof rows[0].code === 'string'
            ? JSON.parse(rows[0].code)
            : rows[0].code;
          if (rows[0].prompt && !artifact.prompt) artifact.prompt = rows[0].prompt;
        }
      } catch (_) { /* fall through */ }
    }
    return artifact || null;
  }

  // ── Helper: load run row (always scoped to user) ──────────────────────────
  async function loadRun(runId, userId) {
    // userId MUST be present — never return unscoped runs
    if (!userId) return null;
    const { rows } = await pool.query(
      `SELECT id, prompt, status FROM pipeline_runs WHERE id = $1 AND user_id = $2`,
      [runId, userId]
    );
    return rows[0] || null;
  }

  // ── GET /api/pipeline/:runId/code-files/download ─────────────────────────
  // Returns raw generated files as a ZIP (existing UI contract from run-view.js).
  // Auth required — downloads contain user-generated code
  router.get('/:runId/code-files/download', authMiddleware, async (req, res) => {
    try {
      const { runId } = req.params;
      if (!/^[0-9a-f-]{36}$/i.test(runId)) {
        return res.status(400).json({ success: false, message: 'Invalid run ID' });
      }

      const userId = req.user?.userId || null;
      const run = await loadRun(runId, userId);
      if (!run) {
        return res.status(404).json({ success: false, message: 'Run not found' });
      }

      const artifact = await loadCodeArtifact(runId);
      const files = artifact?.files || {};
      const appName = deriveAppName(run.prompt);
      const slug = deriveSlug(run.prompt);

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${slug}-source.zip"`);

      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', (err) => { try { res.end(); } catch (_) {} });
      archive.pipe(res);

      if (Object.keys(files).length === 0) {
        // Empty project fallback
        archive.append(
          `// No code files generated for run: ${runId}\n// Prompt: ${run.prompt || '(none)'}\n`,
          { name: 'README.txt' }
        );
      } else {
        for (const [filename, content] of Object.entries(files)) {
          archive.append(String(content), { name: filename });
        }
        // Auto-inject package.json if missing (React builds need npx serve)
        if (!files['package.json'] && !files['Package.json']) {
          archive.append(
            JSON.stringify({ name: slug, version: '1.0.0', scripts: { start: 'npx serve .' } }, null, 2),
            { name: 'package.json' }
          );
        }
      }

      await archive.finalize();

    } catch (err) {
      console.error('[expo-export] code-files/download error:', err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'Failed to generate ZIP' });
      }
    }
  });

  // ── POST /api/builds/:runId/export/expo ─────────────────────────────────
  // Generates an Expo React Native project ZIP from the build's generated files.
  router.post('/:runId/export/expo', authMiddleware, async (req, res) => {
    try {
      const { runId } = req.params;
      if (!/^[0-9a-f-]{36}$/i.test(runId)) {
        return res.status(400).json({ success: false, message: 'Invalid run ID' });
      }

      const userId = req.user?.userId || null;
      const run = await loadRun(runId, userId);
      if (!run) {
        return res.status(404).json({ success: false, message: 'Run not found' });
      }

      const artifact = await loadCodeArtifact(runId);
      const files = artifact?.files || {};
      const appName = deriveAppName(run.prompt);
      const slug = deriveSlug(run.prompt);

      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${slug}-expo.zip"`);

      const archive = archiver('zip', { zlib: { level: 6 } });
      archive.on('error', () => { try { res.end(); } catch (_) {} });
      archive.pipe(res);

      const fileEntries = Object.entries(files);

      if (fileEntries.length === 0) {
        // Minimal fallback app
        archive.append(generateSimpleAppJs(appName), { name: 'App.js' });
        archive.append(generateAppJson(appName, slug), { name: 'app.json' });
        archive.append(generatePackageJson(appName, slug), { name: 'package.json' });
        archive.append(generateBabelConfig(), { name: 'babel.config.js' });
        archive.append(generateReadme(appName, run.prompt), { name: 'README.md' });
        await archive.finalize();
        return;
      }

      // Identify screens (HTML pages) and components
      const screenFiles = fileEntries.filter(([fn]) => fn.endsWith('.html') || (fn.startsWith('screens/') && isWebFile(fn)));
      const componentFiles = fileEntries.filter(([fn]) => !fn.endsWith('.html') && (fn.startsWith('components/') || fn.startsWith('src/')) && isWebFile(fn));
      const appJsxFile = fileEntries.find(([fn]) => fn === 'app.jsx' || fn === 'App.jsx');

      // Convert screens
      const convertedScreens = [];
      for (const [fn, content] of screenFiles.length > 0 ? screenFiles : (appJsxFile ? [appJsxFile] : fileEntries.filter(([fn]) => isWebFile(fn)).slice(0, 5))) {
        const rnContent = convertWebToRN(String(content), fn);
        const baseName = fn.replace(/^.*\//, '').replace(/\.(html|jsx|tsx|js)$/, '');
        const capitalized = baseName.charAt(0).toUpperCase() + baseName.slice(1);
        const rnFilename = capitalized + 'Screen.js';
        const componentName = capitalized + 'Screen';

        convertedScreens.push({ name: capitalized, rnFile: rnFilename });
        archive.append(
          wrapAsRNComponent(rnContent, componentName, true),
          { name: `screens/${rnFilename}` }
        );
      }

      // Convert components
      for (const [fn, content] of componentFiles) {
        const rnContent = convertWebToRN(String(content), fn);
        const baseName = fn.replace(/^.*\//, '').replace(/\.(jsx|tsx|js|ts)$/, '');
        const capitalized = baseName.charAt(0).toUpperCase() + baseName.slice(1);
        archive.append(
          wrapAsRNComponent(rnContent, capitalized, false),
          { name: `components/${capitalized}.js` }
        );
      }

      // Generate App.js
      if (convertedScreens.length > 0) {
        archive.append(generateAppJs(convertedScreens, appName), { name: 'App.js' });
      } else {
        archive.append(generateSimpleAppJs(appName), { name: 'App.js' });
      }

      // Static files
      archive.append(generateAppJson(appName, slug), { name: 'app.json' });
      archive.append(generatePackageJson(appName, slug), { name: 'package.json' });
      archive.append(generateBabelConfig(), { name: 'babel.config.js' });
      archive.append(generateReadme(appName, run.prompt), { name: 'README.md' });

      // Pass through JSON data files (API mocks, etc.)
      for (const [fn, content] of fileEntries) {
        if (fn.endsWith('.json') && fn !== 'package.json') {
          archive.append(String(content), { name: `data/${fn}` });
        }
      }

      await archive.finalize();

    } catch (err) {
      console.error('[expo-export] export/expo error:', err);
      if (!res.headersSent) {
        res.status(500).json({ success: false, message: 'Failed to generate Expo project' });
      }
    }
  });

  return router;
}

module.exports = { createExpoExportRouter };
