import { useNavigate } from 'react-router-dom';
import Post from '@/types/post-type';
import formatPostTime from '@/utils/format-post-time';
import CategoryPill from '@/components/category-pill';
import { createSlug } from '@/utils/slug-generator';
import { FadeIn } from './animations/FadeIn';

export default function PostCard({ post }: { post: Post }) {
  const navigate = useNavigate();
  const slug = createSlug(post.title);
  
  return (
    <FadeIn delay={0} className="w-full">
      <div
        className="active:scale-click group w-full cursor-pointer sm:w-1/2 lg:w-1/3 xl:w-1/4"
        role="article"
        aria-label=`Blog post: ${post.title}`
      >
        <div
          className="mb-4 rounded-lg bg-light shadow-md dark:bg-dark-card sm:mr-8 sm:mt-4"
          onClick={() => navigate(`/details-page/${slug}/${post._id}`, { state: { post } })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              navigate(`/details-page/${slug}/${post._id}`, { state: { post } });
            }
          }}
          tabIndex={0}
        >
          <div className="h-48 w-full overflow-hidden rounded-t-lg">
            <img
              src={post.imageLink}
              alt={post.title || 'Blog post image'}
              className="h-full w-full rounded-t-lg object-cover transition-transform duration-300 ease-in-out will-change-transform sm:group-hover:scale-[1.03]"
              loading="lazy"
              decoding="async"
            />
          </div>
          
          <div className="p-3">
            <div className="mb-1 text-xs text-light-info dark:text-dark-info">
              <span className="font-medium">{post.authorName}</span>
              <span className="mx-1">•</span>
              <span>{formatPostTime(post.timeOfPost)}</span>
            </div>
            
            <h2 className="mb-2 line-clamp-1 text-base font-semibold text-light-title dark:text-dark-title">
              {post.title}
            </h2>
            
            <p className="line-clamp-2 text-sm text-light-description dark:text-dark-description">
              {post.description}
            </p>
            
            <div className="mt-4 flex flex-wrap gap-2">
              {post.categories.slice(0, 3).map((category, index) => (
                <CategoryPill key=`${category}-${index}` category={category} aria-label=`Category: ${category}` />
              ))}
            </div>
          </div>
        </div>
      </div>
    </FadeIn>
  );
}