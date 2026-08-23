import { useState, useEffect } from 'react';

export function useIsMobile(breakpoint: number = 768): boolean {
  const [isMobile, setIsMobile] = useState<boolean>(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const checkMobile = () => setIsMobile(window.innerWidth < breakpoint);
    checkMobile();
    window.addEventListener('resize', checkMobile);
    return () => window.removeEventListener('resize', checkMobile);
  }, [breakpoint]);
  return isMobile;
}

export function useIsTablet(): boolean {
  const [isTablet, setIsTablet] = useState<boolean>(false);
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const checkTablet = () => {
      const width = window.innerWidth;
      setIsTablet(width >= 768 && width < 1024);
    };
    checkTablet();
    window.addEventListener('resize', checkTablet);
    return () => window.removeEventListener('resize', checkTablet);
  }, []);
  return isTablet;
}

export function useBreakpoint(): 'mobile' | 'sm' | 'md' | 'lg' | 'xl' | '2xl' {
  const [breakpoint, setBreakpoint] = useState<'mobile' | 'sm' | 'md' | 'lg' | 'xl' | '2xl'>('mobile');
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const checkBreakpoint = () => {
      const width = window.innerWidth;
      if (width < 640) setBreakpoint('mobile');
      else if (width < 768) setBreakpoint('sm');
      else if (width < 1024) setBreakpoint('md');
      else if (width < 1280) setBreakpoint('lg');
      else if (width < 1536) setBreakpoint('xl');
      else setBreakpoint('2xl');
    };
    checkBreakpoint();
    window.addEventListener('resize', checkBreakpoint);
    return () => window.removeEventListener('resize', checkBreakpoint);
  }, []);
  return breakpoint;
}

export default useIsMobile;