import React from 'react';

interface SlideUpProps {
  children: React.ReactNode;
  delay?: number;
  className?: string;
}

export function SlideUp({ 
  children, 
  delay = 0, 
  className = ''
}: SlideUpProps) {
  return (
    <div 
      style={{ animationDelay: `${delay}ms`, animationFillMode: 'both' }}
      className=`animate-slide-up ${className}`
    >
      {children}
    </div>
  );
}

export default SlideUp;