import './Card.css';
import { ReactNode } from 'react';

interface CardProps {
  children: ReactNode;
  className?: string;
  style?: React.CSSProperties;
}

export default function Card({ children, className = '', style }: CardProps) {
  return (
    <div className={`bo-card ${className}`} style={style}>
      {children}
    </div>
  );
}
