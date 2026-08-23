import { useState, useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import axiosInstance from '@/helpers/axios-instance';
import { toast } from 'react-toastify';
import PostCard from '@/components/post-card';
import { PostCardSkeleton } from '@/components/skeletons/post-card-skeleton';
import { FadeIn } from '@/components/animations/FadeIn';
import { SlideUp } from '@/components/animations/SlideUp';
import useAuthData from '@/hooks/useAuthData';
import userState from '@/utils/user-state';

interface User {
  _id: string;
  userName: string;
  fullName: string;
  email: string;
  role: string;
  createdAt: string;
  bio?: string;
  avatar?: string;
}

interface Post {
  _id: string;
  title: string;
  description: string;
  imageLink: string;
  authorName: string;
  categories: string[];
  timeOfPost: string;
}

export default function UserProfile() {
  const { userId } = useParams<{ userId: string }>();
  const navigate = useNavigate();
  const { token } = useAuthData();
  const currentUser = userState.getUser();
  const [user, setUser] = useState<User | null>(null);
  const [posts, setPosts] = useState<Post[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOwnProfile, setIsOwnProfile] = useState(false);

  useEffect(() => {
    const fetchUserData = async () => {
      try {
        setLoading(true);
        const targetUserId = userId || currentUser?._id;
        if (!targetUserId) { setError('User not found'); setLoading(false); return; }
        setIsOwnProfile(targetUserId === currentUser?._id);
        const userResponse = await axiosInstance.get(`/api/users/${targetUserId}`);
        setUser(userResponse.data);
        const postsResponse = await axiosInstance.get(`/api/posts/user/${targetUserId}`);
        setPosts(postsResponse.data);
        setError(null);
      } catch (err) {
        console.error('Failed to fetch user data:', err);
        setError('Failed to load profile.');
      } finally {
        setLoading(false);
      }
    };
    fetchUserData();
  }, [userId, currentUser?._id]);

  const formatDate = (dateString: string) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  };

  const getInitials = (name: string) => {
    return name.split(' ').map((part) => part.charAt(0).toUpperCase()).slice(0, 2).join('');
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-light dark:bg-dark p-4">
        <FadeIn delay={0}>
          <div className="w-full max-w-4xl space-y-6">
            <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start">
              <div className="h-24 w-24 rounded-full bg-light-field dark:bg-dark-field animate-pulse sm:h-32 sm:w-32" />
              <div className="flex-1 space-y-3">
                <div className="h-8 w-1/3 rounded bg-light-field dark:bg-dark-field animate-pulse" />
                <div className="h-4 w-1/2 rounded bg-light-field dark:bg-dark-field animate-pulse" />
                <div className="h-4 w-1/4 rounded bg-light-field dark:bg-dark-field animate-pulse" />
              </div>
            </div>
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {Array(6).fill(0).map((_, index) => (<PostCardSkeleton key={index} />))}
            </div>
          </div>
        </FadeIn>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-light dark:bg-dark p-4">
        <FadeIn delay={0}>
          <div className="text-center">
            <h1 className="text-2xl font-semibold text-light-primary dark:text-dark-primary mb-4">{error}</h1>
            <button onClick={() => navigate(-1)} className="rounded-lg bg-brand-primary px-6 py-3 text-white font-medium hover:bg-brand-secondary">Go Back</button>
          </div>
        </FadeIn>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-light dark:bg-dark p-4">
        <FadeIn delay={0}>
          <div className="text-center">
            <h1 className="text-2xl font-semibold text-light-primary dark:text-dark-primary mb-4">User Not Found</h1>
            <button onClick={() => navigate(-1)} className="rounded-lg bg-brand-primary px-6 py-3 text-white font-medium hover:bg-brand-secondary">Go Back</button>
          </div>
        </FadeIn>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-light dark:bg-dark p-4">
      <div className="mx-auto max-w-6xl">
        <FadeIn delay={0}>
          <div className="mb-8">
            <button onClick={() => navigate(-1)} className="mb-6 flex items-center gap-2 text-light-primary dark:text-dark-primary hover:text-brand-primary">
              <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
              Back to Posts
            </button>
            <div className="rounded-2xl bg-light-field dark:bg-dark-card border border-light-border dark:border-dark-border p-6 shadow-lg">
              <div className="flex flex-col items-center gap-4 sm:flex-row sm:items-start sm:gap-6">
                <div className="flex-shrink-0">
                  {user.avatar ? (
                    <img src={user.avatar} alt=`${user.fullName}'s avatar` className="h-24 w-24 rounded-full object-cover sm:h-32 sm:w-32" loading="lazy" />
                  ) : (
                    <div className="h-24 w-24 rounded-full bg-brand-primary flex items-center justify-center text-white text-2xl font-bold sm:h-32 sm:w-32">{getInitials(user.fullName)}</div>
                  )}
                </div>
                <div className="flex-1 min-w-0 text-center sm:text-left">
                  <SlideUp delay={100}><h1 className="text-2xl font-bold text-light-primary dark:text-dark-primary">{user.fullName}</h1></SlideUp>
                  <SlideUp delay={150}><div className="text-lg text-light-secondary dark:text-dark-secondary">@{user.userName}</div></SlideUp>
                  <SlideUp delay={200}>{user.bio && <p className="mt-2 text-light-tertiary dark:text-dark-tertiary">{user.bio}</p>}</SlideUp>
                  <SlideUp delay={250}>
                    <div className="mt-4 flex items-center justify-center gap-4 sm:justify-start">
                      <div className="text-sm"><span className="font-medium">{posts.length}</span><span className="text-light-tertiary dark:text-dark-tertiary"> posts</span></div>
                      <div className="text-sm"><span className="font-medium">Joined</span><span className="text-light-tertiary dark:text-dark-tertiary"> {formatDate(user.createdAt)}</span></div>
                    </div>
                  </SlideUp>
                  {isOwnProfile && token && (
                    <SlideUp delay={300}>
                      <div className="mt-4 flex justify-center sm:justify-start">
                        <Link to="/settings" className="rounded-lg bg-light-secondary dark:bg-dark-secondary px-4 py-2 text-sm font-medium hover:bg-light-tertiary dark:hover:bg-dark-tertiary">Edit Profile</Link>
                      </div>
                    </SlideUp>
                  )}
                </div>
              </div>
            </div>
          </div>
        </FadeIn>
        <div>
          <FadeIn delay={100}><h2 className="mb-6 text-xl font-semibold text-light-primary dark:text-dark-primary">{user.fullName}'s Posts</h2></FadeIn>
          {posts.length === 0 ? (
            <FadeIn delay={150}>
              <div className="rounded-lg bg-light-field dark:bg-dark-field border border-light-border dark:border-dark-border p-8 text-center">
                <p className="text-light-tertiary dark:text-dark-tertiary">
                  {isOwnProfile ? "You haven't created any posts yet." : `${user.fullName} hasn't created any posts yet.`}
                </p>
                {isOwnProfile && token && (
                  <div className="mt-4">
                    <Link to="/add-blog" className="inline-flex items-center gap-2 rounded-lg bg-brand-primary px-6 py-3 text-white font-medium hover:bg-brand-secondary">
                      <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
                      Create Your First Post
                    </Link>
                  </div>
                )}
              </div>
            </FadeIn>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {posts.map((post, index) => (
                <FadeIn key={post._id} delay={200 + index * 30}><PostCard post={post} /></FadeIn>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}