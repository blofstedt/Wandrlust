/** @type {import('tailwindcss').Config} */
import colors from 'tailwindcss/colors';
import defaultTheme from 'tailwindcss/defaultTheme';

export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  darkMode: 'class',
  theme: {
    extend: {
      colors: {
        semantic: {
          success: '#22c55e',
          error: '#ef4444',
          warning: '#f59e0b',
          info: '#3b82f6',
        },
        dark: {
          DEFAULT: colors.slate[900],
          primary: colors.slate[50],
          secondary: colors.slate[300],
          tertiary: colors.slate[400],
          card: colors.slate[800],
          title: colors.slate[50],
          description: colors.slate[400],
          info: colors.slate[500],
          field: colors.slate[900],
          button: colors.slate[700],
          textInField: colors.slate[50],
          textColor: colors.slate[50],
          border: colors.slate[700],
        },
        light: {
          DEFAULT: colors.slate[50],
          primary: colors.slate[900],
          secondary: colors.slate[600],
          tertiary: colors.slate[500],
          title: colors.slate[900],
          description: colors.slate[700],
          info: colors.slate[500],
          field: colors.zinc[100],
          textInField: colors.slate[900],
          textColor: colors.slate[900],
          border: colors.zinc[300],
        },
        'light-theme-background': '#fef3c7',
        'light-theme-foreground': '#f59e0b',
        'dark-theme-background': '#1e3a8a',
        'dark-theme-foreground': '#3b82f6',
        brand: {
          primary: '#3b82f6',
          secondary: '#8b5cf6',
          accent: '#f59e0b',
        },
      },
      fontFamily: {
        sans: ['Poppins', ...defaultTheme.fontFamily.sans],
      },
      animation: {
        'fade-in': 'fadeIn 0.3s ease-out',
        'fade-in-up': 'fadeInUp 0.5s ease-out',
        'slide-up': 'slideUp 0.4s ease-out',
        'slide-down': 'slideDown 0.3s ease-out',
        'pulse-soft': 'pulseSoft 2s ease-in-out infinite',
        'spin-slow': 'spin 3s linear infinite',
      },
      keyframes: {
        fadeIn: { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        fadeInUp: { '0%': { opacity: '0', transform: 'translateY(20px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        slideUp: { '0%': { transform: 'translateY(20px)', opacity: '0' }, '100%': { transform: 'translateY(0)', opacity: '1' } },
        slideDown: { '0%': { transform: 'translateY(-20px)', opacity: '0' }, '100%': { transform: 'translateY(0)', opacity: '1' } },
        pulseSoft: { '0%, 100%': { opacity: '1' }, '50%': { opacity: '0.8' } },
      },
    },
  },
  plugins: [],
};