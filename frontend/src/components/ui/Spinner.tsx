import React from 'react';

interface SpinnerProps {
  size?: 'sm' | 'md' | 'lg' | 'xl';
  className?: string;
  variant?: 'primary' | 'secondary' | 'light' | 'dark';
}

export function Spinner({ 
  size = 'md',
  className = '',
  variant = 'primary'
}: SpinnerProps) {
  const sizeClasses = {
    sm: 'h-4 w-4 border-2',
    md: 'h-6 w-6 border-3',
    lg: 'h-8 w-8 border-4',
    xl: 'h-12 w-12 border-6',
  };

  const variantClasses = {
    primary: 'border-brand-primary border-r-transparent',
    secondary: 'border-brand-secondary border-r-transparent',
    light: 'border-light-primary border-r-transparent dark:border-dark-primary',
    dark: 'border-dark-primary border-r-transparent',
  };

  return (
    <div 
      role="status"
      aria-label="Loading"
      className=`animate-spin-slow rounded-full border-solid ${sizeClasses[size]} ${variantClasses[variant]} ${className}`
    >
      <span className="sr-only">Loading...</span>
    </div>
  );
}

export default Spinner;