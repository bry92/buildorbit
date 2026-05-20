import { useEffect, useRef, useState } from "react";

interface LivePreviewProps {
  html: string;
  css?: string;
  js?: string;
  autoReload?: boolean;
  className?: string;
}

export function BuildOrbitPreview({
  html,
  css = "",
  js = "",
  autoReload = true,
  className = ""
}: LivePreviewProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [loading, setLoading] = useState(true);
  const [logs, setLogs] = useState<string[]>([]);
  const [snapshots, setSnapshots] = useState<string[]>([]);
  const [compilePulse, setCompilePulse] = useState(false);

  // Console bridge script — injected into every preview for error/log capture
  const consoleBridge = `
    <script>
      const send = (type, payload) => {
        parent.postMessage({ type, payload }, "*");
      };
      const _origLog = console.log;
      const _origErr = console.error;
      console.log = (...args) => { send("log", args.join(" ")); _origLog.apply(console, args); };
      console.error = (...args) => { send("error", args.join(" ")); _origErr.apply(console, args); };
      window.onerror = (msg, src, line, col, err) => {
        send("error", msg.toString());
      };
    </script>`;

  const buildDocument = () => {
    // Detect if HTML is already a complete document (React CDN builds with
    // inlined Babel scripts, or any self-contained HTML from previewAssets).
    // These need to be rendered as-is — wrapping them in another <html> creates
    // nested documents that break CDN script loading and Babel compilation.
    const isCompleteDocument = html.trim().match(/^<!doctype|^<html/i);

    if (isCompleteDocument && !css && !js) {
      // Self-contained document — inject console bridge before </head> or </body>
      let doc = html;
      if (doc.includes('</head>')) {
        doc = doc.replace('</head>', `${consoleBridge}\n</head>`);
      } else if (doc.includes('</body>')) {
        doc = doc.replace('</body>', `${consoleBridge}\n</body>`);
      } else {
        doc = doc + consoleBridge;
      }
      return doc;
    }

    // Fragment HTML — wrap in a document with injected CSS/JS
    return `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <style>
          html, body {
            margin: 0;
            padding: 0;
            background: transparent;
            font-family: system-ui, sans-serif;
          }
          ${css}
        </style>
        ${consoleBridge}
      </head>
      <body>
        ${html}

        <script>
          try {
            ${js}
          } catch (err) {
            parent.postMessage({ type: "error", payload: err.toString() }, "*");
          }
        </script>
      </body>
      </html>
    `;
  };

  const renderIframe = () => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const doc = iframe.contentDocument;
    if (!doc) return;

    setCompilePulse(true);
    setTimeout(() => setCompilePulse(false), 600);

    setLoading(true);
    doc.open();
    doc.write(buildDocument());
    doc.close();

    iframe.onload = () => {
      setLoading(false);
      autoResize();
      captureSnapshot();
    };
  };

  const autoResize = () => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    const doc = iframe.contentDocument;
    if (!doc) return;

    const ro = new ResizeObserver(() => {
      iframe.style.height = doc.body.scrollHeight + "px";
    });

    ro.observe(doc.body);
  };

  const captureSnapshot = () => {
    const iframe = iframeRef.current;
    if (!iframe) return;

    try {
      const canvas = document.createElement("canvas");
      const rect = iframe.getBoundingClientRect();
      canvas.width = rect.width;
      canvas.height = rect.height;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const placeholder =
        "data:image/svg+xml;base64," +
        btoa(
          `<svg xmlns='http://www.w3.org/2000/svg' width='300' height='200'>
            <rect width='100%' height='100%' fill='#0A1A1F'/>
            <text x='50%' y='50%' fill='#00FFC8' font-size='20' text-anchor='middle'>Snapshot</text>
          </svg>`
        );

      setSnapshots((prev) => [...prev.slice(-4), placeholder]);
    } catch {}
  };

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.data.type === "log") {
        setLogs((prev) => [...prev, `LOG: ${event.data.payload}`]);
      }
      if (event.data.type === "error") {
        setLogs((prev) => [...prev, `ERROR: ${event.data.payload}`]);
      }
    };

    window.addEventListener("message", handler);
    return () => window.removeEventListener("message", handler);
  }, []);

  useEffect(() => {
    if (autoReload) renderIframe();
  }, [html, css, js]);

  return (
    <div className={`space-y-3 ${className}`}>
      {/* Compile Bar */}
      <div
        className={`
          h-1 rounded-full overflow-hidden bg-[#0A1A1F]
          relative transition-all duration-300
        `}
      >
        <div
          className={`
            absolute inset-y-0 left-0 w-full
            bg-gradient-to-r from-[#00FFC8] to-[#00A0FF]
            transition-transform duration-[600ms]
            ${compilePulse ? "translate-x-0" : "-translate-x-full"}
          `}
        />
      </div>

      {/* Preview Container */}
      <div
        className={`
          relative w-full rounded-xl overflow-hidden
          bg-[#05070A]
          border border-[#0A1A1F]
          shadow-[0_0_40px_rgba(0,255,200,0.15)]
          backdrop-blur-xl
          transition-all duration-500
          ${loading ? "opacity-0 scale-[0.98]" : "opacity-100 scale-100"}
        `}
      >
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-cyan-300/60 text-sm">
            Rendering BuildOrbit preview…
          </div>
        )}

        <iframe
          ref={iframeRef}
          sandbox="allow-scripts allow-same-origin"
          className="w-full transition-opacity duration-300"
          style={{
            opacity: loading ? 0 : 1,
            borderRadius: "16px"
          }}
        />
      </div>

      {/* Console Panel */}
      <div className="bg-[#05070A] border border-[#0A1A1F] rounded-lg p-3 text-xs text-cyan-300/80 font-mono max-h-40 overflow-auto">
        {logs.length === 0 ? (
          <div className="opacity-40">Console output will appear here</div>
        ) : (
          logs.map((l, i) => <div key={i}>{l}</div>)
        )}
      </div>

      {/* Snapshot Strip */}
      <div className="flex gap-2 overflow-x-auto py-2">
        {snapshots.map((src, i) => (
          <img
            key={i}
            src={src}
            className="w-24 h-16 object-cover rounded-md border border-[#0A1A1F] shadow-[0_0_10px_rgba(0,255,200,0.1)]"
          />
        ))}
      </div>
    </div>
  );
}
