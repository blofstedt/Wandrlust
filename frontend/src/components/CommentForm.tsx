import { useState } from 'react';
import { FadeIn } from './animations/FadeIn';

interface CommentFormProps {
  onSubmit: (text: string) => Promise<boolean>;
  className?: string;
  placeholder?: string;
}

export default function CommentForm({
  onSubmit,
  className = '',
  placeholder = 'Share your thoughts...',
}: CommentFormProps) {
  const [text, setText] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) {
      setError('Comment cannot be empty');
      return;
    }
    if (text.length > 2000) {
      setError('Comment is too long (max 2000 characters)');
      return;
    }
    setError(null);
    setIsSubmitting(true);
    try {
      const success = await onSubmit(text);
      if (success) setText('');
    } catch (err) {
      console.error('Comment submission error:', err);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <FadeIn delay={0} className=`rounded-lg bg-light-field dark:bg-dark-field border border-light-border dark:border-dark-border p-4 ${className}`>
      <form onSubmit={handleSubmit} className="space-y-3">
        <div>
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={placeholder}
            className="w-full rounded-lg bg-light dark:bg-dark p-3 text-light-primary dark:text-dark-primary placeholder:text-light-tertiary dark:placeholder:text-dark-tertiary border border-light-border dark:border-dark-border focus:outline-none focus:ring-2 focus:ring-brand-primary/50 resize-none min-h-[100px] transition-all duration-200"
            aria-label="Comment"
            maxLength={2000}
          />
          <div className="mt-1 text-right text-xs text-light-tertiary dark:text-dark-tertiary">
            {text.length}/2000 characters
          </div>
        </div>
        {error && (
          <FadeIn delay={0}><div className="text-sm text-red-500 dark:text-red-400">{error}</div></FadeIn>
        )}
        <div className="flex justify-end">
          <button
            type="submit"
            disabled={isSubmitting || !text.trim()}
            className="active:scale-click rounded-lg bg-brand-primary px-6 py-2 text-white font-medium hover:bg-brand-secondary disabled:opacity-50 disabled:cursor-not-allowed transition-colors duration-200"
          >
            {isSubmitting ? 'Posting...' : 'Post Comment'}
          </button>
        </div>
      </form>
    </FadeIn>
  );
}