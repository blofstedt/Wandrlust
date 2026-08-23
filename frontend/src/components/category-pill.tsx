import { getCategoryColors } from '@/utils/category-colors';
import { twMerge } from 'tailwind-merge';

interface CategoryPillProps extends React.HTMLAttributes<HTMLButtonElement> {
  category: string;
  selected?: boolean;
  disabled?: boolean;
}

export default function CategoryPill({
  category,
  selected = false,
  disabled = false,
  className = '',
  ...props
}: CategoryPillProps) {
  const [bgColor, hoverColor] = getCategoryColors(category);

  return (
    <button
      type="button"
      disabled={disabled}
      className={twMerge(`
        flex items-center justify-center
        min-h-[44px] min-w-[44px] px-4 py-2
        rounded-full text-xs font-medium
        transition-all duration-200 ease-in-out
        ${bgColor}
        ${selected ? hoverColor : ''}
        ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
        hover:opacity-90
        active:scale-click
        focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-brand-primary/50
        ${className}
      `)}
      aria-label={disabled ? `Category ${category} (max selected)+ : `Filter by ${category}`}
      aria-pressed={selected}
      aria-disabled={disabled}
      {...props}
    >
      {category}
    </button>
  );
}