import { useState, useEffect } from 'react';
import axiosInstance from '@/helpers/axios-instance';
import { toast } from 'react-toastify';
import { FadeIn } from './animations/FadeIn';
import CommentForm from './CommentForm';
import useAuthData from '@/hooks/useAuthData';

interface Comment {
  _id: string;
  postId: string;
  userId: string;
  userName: string;
  text: string;
  createdAt: string;
}

interface CommentSectionProps {
  postId: string;
  className?: string;
}

export default function CommentSection({ postId, className = '' }: CommentSectionProps) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { token } = useAuthData();

  useEffect(() => {
    const fetchComments = async () => {
      try {
        setLoading(true);
        const response = await axiosInstance.get(`/api/comments/post/${postId}`);
        setComments(response.data);
        setError(null);
      } catch (err) {
        console.error('Failed to fetch comments:', err);
        setError('Failed to load comments.');
      } finally {
        setLoading(false);
      }
    };
    fetchComments();
  }, [postId]);

  const handleAddComment = async (text: string) => {
    try {
      const response = await axiosInstance.post('/api/comments', { postId, text });
      setComments([response.data, ...comments]);
      toast.success('Comment posted!');
      return true;
    } catch (err) {
      console.error('Failed to post comment:', err);
      toast.error('Failed to post comment.');
      return false;
    }
  };

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    const now = new Date();
    const diffInHours = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60));
    if (diffInHours < 1) return 'Just now';
    else if (diffInHours < 24) return `${diffInHours}h ago`;
    else if (diffInHours < 168) return `${Math.floor(diffInHours / 24)}d ago`;
    else return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  };

  return (
    <FadeIn delay={0} className=`mt-12 ${className}`>
      <div className="border-t border-light-border dark:border-dark-border pt-8">
        <div className="mb-6">
          <h2 className="text-2xl font-semibold text-light-primary dark:text-dark-primary">Comments ({comments.length})</h2>
          <p className="text-light-tertiary dark:text-dark-tertiary">Share your thoughts</p>
        </div>
        {token ? (
          <FadeIn delay={100}><CommentForm onSubmit={handleAddComment} /></FadeIn>
        ) : (
          <FadeIn delay={100}>
            <div className="mb-8 rounded-lg bg-light-secondary/50 dark:bg-dark-secondary/50 border border-light-border dark:border-dark-border p-4 text-center">
              <p className="text-light-tertiary dark:text-dark-tertiary">
                Please <span className="cursor-pointer font-medium text-brand-primary hover:text-brand-secondary" onClick={() => window.location.href = '/signin'}>sign in</span> to comment.
              </p>
            </div>
          </FadeIn>
        )}
        {loading && (
          <FadeIn delay={0}>
            <div className="space-y-4">
              {Array(3).fill(0).map((_, index) => (
                <div key={index} className="flex gap-3 p-4">
                  <div className="h-10 w-10 rounded-full bg-light-field dark:bg-dark-field animate-pulse" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 w-1/4 rounded bg-light-field dark:bg-dark-field animate-pulse" />
                    <div className="h-3 w-full rounded bg-light-field dark:bg-dark-field animate-pulse" />
                  </div>
                </div>
              ))}
            </div>
          </FadeIn>
        )}
        {error && !loading && (
          <FadeIn delay={0}>
            <div className="rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 p-4 text-red-600 dark:text-red-400">
              {error}
            </div>
          </FadeIn>
        )}
        {!loading && !error && comments.length === 0 && (
          <FadeIn delay={0}>
            <div className="text-center py-8">
              <p className="text-light-tertiary dark:text-dark-tertiary">No comments yet. Be the first!</p>
            </div>
          </FadeIn>
        )}
        {!loading && !error && comments.length > 0 && (
          <div className="space-y-6">
            {comments.map((comment, index) => (
              <FadeIn key={comment._id} delay={200 + index * 50}>
                <div className="flex gap-3 p-4 rounded-lg bg-light-field dark:bg-dark-field border border-light-border dark:border-dark-border">
                  <div className="flex-shrink-0">
                    <div className="h-10 w-10 rounded-full bg-brand-primary flex items-center justify-center text-white font-medium">
                      {comment.userName.charAt(0).toUpperCase()}
                    </div>
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="font-medium text-light-primary dark:text-dark-primary">{comment.userName}</div>
                        <div className="text-xs text-light-tertiary dark:text-dark-tertiary">{formatDate(comment.createdAt)}</div>
                      </div>
                    </div>
                    <div className="mt-2 text-light-secondary dark:text-dark-secondary whitespace-pre-wrap">{comment.text}</div>
                  </div>
                </div>
              </FadeIn>
            ))}
          </div>
        )}
      </div>
    </FadeIn>
  );
}