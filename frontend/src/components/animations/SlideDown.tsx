import React from 'react';

interface SlideDownProps {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}

export function SlideDown({ 
  children, 
  delay = 0, 
  className = ''
}: SlideDownProps) {
  return (
    <div 
      style={{ animationDelay: `${delay}ms`, animationFillMode: 'both' }}
      className=`animate-slide-down ${className}`
    >
      {children}
    </div>
  );
}

export default SlideDown;