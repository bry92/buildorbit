import { Link } from 'react-router-dom';

export default function NotFound() {
  return (
    <div style={{
      minHeight: '100vh',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 20,
      fontFamily: "'Space Grotesk', sans-serif",
      color: 'var(--text)',
      textAlign: 'center',
      padding: 24,
    }}>
      <div style={{ fontSize: 72, opacity: 0.3 }}>404</div>
      <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700 }}>Page not found</h1>
      <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 14 }}>
        This page doesn't exist or you don't have access.
      </p>
      <Link
        to="/dashboard"
        style={{
          marginTop: 8,
          height: 36,
          padding: '0 18px',
          display: 'inline-flex',
          alignItems: 'center',
          borderRadius: 8,
          background: 'var(--accent)',
          color: '#060a14',
          fontSize: 13,
          fontWeight: 700,
          textDecoration: 'none',
        }}
      >
        ← Dashboard
      </Link>
    </div>
  );
}
