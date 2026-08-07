import './Card.css';
import { MouseEvent, ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
  tilt?: boolean;
}

export default function Card({ children, className = '', style, tilt = true }: CardProps) {
  const handleMove = (event: MouseEvent<HTMLDivElement>) => {
    if (!tilt || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width - 0.5) * 4;
    const y = ((event.clientY - rect.top) / rect.height - 0.5) * -4;
    event.currentTarget.style.setProperty('--tilt-x', `${y}deg`);
    event.currentTarget.style.setProperty('--tilt-y', `${x}deg`);
  };

  const handleLeave = (event: MouseEvent<HTMLDivElement>) => {
    event.currentTarget.style.setProperty('--tilt-x', '0deg');
    event.currentTarget.style.setProperty('--tilt-y', '0deg');
  };

  return (
    <div
      className={`bo-card ${tilt ? 'bo-card--tilt' : ''} ${className}`}
      style={style}
      onMouseMove={handleMove}
      onMouseLeave={handleLeave}
    >
      {children}
    </div>
  );
}
