import React from 'react';

interface FadeInProps {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  duration?: 'fast' | 'normal' | 'slow';
}

export function FadeIn({ 
  children, 
  delay = 0, 
  className = '',
  duration = 'normal'
}: FadeInProps) {
  const durationClasses = {
    fast: 'animate-[fadeIn_0.2s_ease-out]',
    normal: 'animate-fade-in',
    slow: 'animate-[fadeIn_0.5s_ease-out]',
  };

  return (
    <div 
      style={{ animationDelay: `${delay}ms`, animationFillMode: 'both' }}
      className=`${durationClasses[duration]} ${className}`
    >
      {children}
    </div>
  );
}

export default FadeIn;