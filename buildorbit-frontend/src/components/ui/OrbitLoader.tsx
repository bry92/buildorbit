import './OrbitLoader.css';

interface OrbitLoaderProps {
  label?: string;
  size?: 'sm' | 'md';
}

export default function OrbitLoader({ label, size = 'md' }: OrbitLoaderProps) {
  return (
    <span className={`orbit-loader orbit-loader--${size}`} role={label ? 'status' : undefined} aria-label={label}>
      <span className="orbit-loader__ring">
        <span className="orbit-loader__dot" />
      </span>
      {label && <span className="orbit-loader__label">{label}</span>}
    </span>
  );
}
