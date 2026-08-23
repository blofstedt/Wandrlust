import { useState } from 'react';
import { toast } from 'react-toastify';
import { FadeIn } from './animations/FadeIn';

interface SocialShareProps {
  postId: string;
  postTitle: string;
  className?: string;
}

export default function SocialShare({
  postId,
  postTitle,
  className = '',
}: SocialShareProps) {
  const [isCopied, setIsCopied] = useState(false);
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : '';
  const postUrl = `${baseUrl}/details-page/${postId}`;
  const encodedUrl = encodeURIComponent(postUrl);
  const encodedText = encodeURIComponent(postTitle);

  const shareLinks = {
    twitter: `https://twitter.com/intent/tweet?text=${encodedText}&url=${encodedUrl}`,
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${encodedUrl}`,
    linkedin: `https://www.linkedin.com/shareArticle?mini=true&title=${encodedText}&url=${encodedUrl}`,
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(postUrl);
      setIsCopied(true);
      toast.success('Link copied!');
      setTimeout(() => setIsCopied(false), 2000);
    } catch (error) {
      toast.error('Failed to copy');
    }
  };

  const openShareDialog = () => {
    if (navigator.share) {
      navigator.share({ title: postTitle, text: postTitle, url: postUrl })
        .catch((error) => { if (error.name !== 'AbortError') console.error('Share error:', error); });
    } else {
      copyToClipboard();
    }
  };

  return (
    <FadeIn delay={0} className=`flex items-center gap-2 ${className}`>
      <span className="text-sm font-medium text-light-tertiary dark:text-dark-tertiary">Share:</span>
      <a href={shareLinks.twitter} target="_blank" rel="noopener noreferrer"
        className="p-2 rounded-lg hover:bg-light-secondary/50 dark:hover:bg-dark-secondary/50 transition-colors"
        aria-label="Share on Twitter">
        <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" /></svg>
      </a>
      <a href={shareLinks.facebook} target="_blank" rel="noopener noreferrer"
        className="p-2 rounded-lg hover:bg-light-secondary/50 dark:hover:bg-dark-secondary/50 transition-colors"
        aria-label="Share on Facebook">
        <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24"><path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z" /></svg>
      </a>
      <button onClick={copyToClipboard}
        className="p-2 rounded-lg hover:bg-light-secondary/50 dark:hover:bg-dark-secondary/50 transition-colors"
        aria-label={isCopied ? 'Copied!' : 'Copy link'}>
        {isCopied ? (
          <svg className="h-5 w-5 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
        ) : (
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>
        )}
      </button>
      {navigator.share && (
        <button onClick={openShareDialog} className="p-2 rounded-lg hover:bg-light-secondary/50 dark:hover:bg-dark-secondary/50 transition-colors lg:hidden"
          aria-label="Share">
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.684 13.342C8.886 12.938 9 12.482 9 12c0-.482-.114-.938-.316-1.342m0 2.684a3 3 0 110-2.684m0 2.684l6.632 3.316m-6.632-6l6.632-3.316m0 0a3 3 0 105.367-2.684 3 3 0 00-5.367 2.684zm0 9.316a3 3 0 105.368 2.684 3 3 0 00-5.368-2.684z" /></svg>
        </button>
      )}
    </FadeIn>
  );
}