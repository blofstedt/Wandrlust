import { useEffect, useState } from 'react';
import BlogFeed from '@/components/blog-feed';
import PostCard from '@/components/post-card';
import Post from '@/types/post-type';
import { PostCardSkeleton } from '@/components/skeletons/post-card-skeleton';
import Header from '@/layouts/header-layout';
import axiosInstance from '@/helpers/axios-instance';
import { FadeIn } from '@/components/animations/FadeIn';

export default function HomePage() {
  const [posts, setPosts] = useState<Post[]>([]);

  useEffect(() => {
    const fetchPosts = async () => {
      try {
        const res = await axiosInstance.get('/api/posts');
        setPosts(res.data);
      } catch (error) {
        console.error(error);
      }
    };
    fetchPosts();
  }, []);

  return (
    <div className="w-full cursor-default bg-light dark:bg-dark">
      <Header />
      <div className="mx-4 sm:mx-8 md:mx-12 lg:mx-16 xl:mx-24 2xl:mx-auto 2xl:max-w-7xl">
        <BlogFeed />
        <FadeIn delay={100}>
          <h1 className="cursor-text pb-4 text-xl font-semibold dark:text-dark-primary sm:pb-0">All Posts</h1>
        </FadeIn>
        <div className="flex flex-wrap">
          {posts.length === 0
            ? Array(8).fill(0).map((_, index) => (
                <FadeIn key={index} delay={200 + index * 30}><PostCardSkeleton /></FadeIn>
              ))
            : posts.map((post, index) => (
                <FadeIn key={post._id} delay={200 + index * 30}><PostCard post={post} /></FadeIn>
              ))}
        </div>
      </div>
    </div>
  );
}