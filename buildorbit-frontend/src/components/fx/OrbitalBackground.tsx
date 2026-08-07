import { useEffect, useRef } from 'react';
import './OrbitalBackground.css';

type Star = {
  x: number;
  y: number;
  r: number;
  alpha: number;
  depth: number;
};

const DEPTHS = [0.2, 0.5, 1];

function createStars(width: number, height: number): Star[] {
  const density = Math.min(150, Math.max(70, Math.floor((width * height) / 16000)));
  return Array.from({ length: density }, (_, index) => {
    const depth = DEPTHS[index % DEPTHS.length];
    return {
      x: Math.random() * width,
      y: Math.random() * height,
      r: depth === 1 ? Math.random() * 1.2 + 0.6 : Math.random() * 0.8 + 0.35,
      alpha: depth === 1 ? Math.random() * 0.42 + 0.28 : Math.random() * 0.28 + 0.12,
      depth,
    };
  });
}

export default function OrbitalBackground() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let stars: Star[] = [];
    let visible = true;
    let width = 0;
    let height = 0;
    let frame = 0;

    const resize = () => {
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.floor(width * ratio);
      canvas.height = Math.floor(height * ratio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      stars = createStars(width, height);
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      for (const star of stars) {
        if (!reduceMotion) {
          star.y += 0.018 * star.depth;
          star.x += 0.006 * star.depth;
          if (star.y > height + 4) star.y = -4;
          if (star.x > width + 4) star.x = -4;
        }
        ctx.beginPath();
        ctx.fillStyle = `rgba(240, 244, 248, ${star.alpha})`;
        ctx.arc(star.x, star.y, star.r, 0, Math.PI * 2);
        ctx.fill();
      }
      frame += 1;
      if (!reduceMotion && visible) raf = window.requestAnimationFrame(draw);
    };

    const observer = new IntersectionObserver(entries => {
      visible = entries[0]?.isIntersecting ?? true;
      if (visible && !raf && !reduceMotion) raf = window.requestAnimationFrame(draw);
      if (!visible && raf) {
        window.cancelAnimationFrame(raf);
        raf = 0;
      }
    });

    resize();
    draw();
    observer.observe(canvas);
    window.addEventListener('resize', resize);

    return () => {
      observer.disconnect();
      window.removeEventListener('resize', resize);
      if (raf) window.cancelAnimationFrame(raf);
      void frame;
    };
  }, []);

  return (
    <div className="orbital-background" aria-hidden="true">
      <canvas ref={canvasRef} className="orbital-background__stars" />
      <div className="orbital-background__nebula" />
      <div className="orbital-background__dust" />
      <div className="orbital-background__rings">
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}
