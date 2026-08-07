import { ReactNode } from 'react';

interface AnimatedSectionProps {
  children: ReactNode;
  className?: string;
  index?: number;
}

export default function AnimatedSection({ children, className = '', index = 0 }: AnimatedSectionProps) {
  return (
    <section
      className={`bo-animated-section ${className}`}
      style={{ animationDelay: `calc(${index} * var(--stagger-step))` }}
    >
      {children}
    </section>
  );
}
