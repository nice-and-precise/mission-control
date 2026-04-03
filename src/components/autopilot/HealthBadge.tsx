'use client';

import { useEffect, useRef, useState } from 'react';

interface Props {
  score: number;
  size?: number;
  showLabel?: boolean;
}

/**
 * Circular progress badge showing product health score.
 * Color-coded: green ≥70, yellow 40-69, red <40.
 * Smooth CSS animation on mount and updates.
 */
export function HealthBadge({ score, size = 44, showLabel = true }: Props) {
  const [animatedScore, setAnimatedScore] = useState(0);
  const animatedScoreRef = useRef(0);

  useEffect(() => {
    const start = animatedScoreRef.current;
    const diff = score - start;
    const duration = 600;
    const startTime = performance.now();

    function animate(now: number) {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      const nextScore = Math.round(start + diff * eased);
      animatedScoreRef.current = nextScore;
      setAnimatedScore(nextScore);
      if (progress < 1) requestAnimationFrame(animate);
    }

    requestAnimationFrame(animate);
  }, [score]);

  const radius = (size - 6) / 2;
  const circumference = 2 * Math.PI * radius;
  const progress = (animatedScore / 100) * circumference;
  const offset = circumference - progress;

  const color =
    animatedScore >= 70
      ? '#3fb950'
      : animatedScore >= 40
      ? '#d29922'
      : '#f85149';

  const bgColor =
    animatedScore >= 70
      ? 'rgba(63, 185, 80, 0.1)'
      : animatedScore >= 40
      ? 'rgba(210, 153, 34, 0.1)'
      : 'rgba(248, 81, 73, 0.1)';

  return (
    <div
      className="relative flex items-center justify-center"
      style={{ width: size, height: size }}
      title={`Health Score: ${animatedScore}/100`}
    >
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        className="transform -rotate-90"
      >
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill={bgColor}
          stroke="rgba(48, 54, 61, 0.6)"
          strokeWidth={3}
        />
        <circle
          cx={size / 2}
          cy={size / 2}
          r={radius}
          fill="none"
          stroke={color}
          strokeWidth={3}
          strokeDasharray={circumference}
          strokeDashoffset={offset}
          strokeLinecap="round"
          style={{ transition: 'stroke-dashoffset 0.6s cubic-bezier(0.33, 1, 0.68, 1)' }}
        />
      </svg>
      {showLabel && (
        <span
          className="absolute text-xs font-bold"
          style={{ color, fontSize: size < 40 ? '9px' : '11px' }}
        >
          {animatedScore}
        </span>
      )}
    </div>
  );
}
