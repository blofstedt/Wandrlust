import { useNavigate } from 'react-router-dom';
import useAuthData from '@/hooks/useAuthData';
import { FadeIn } from './animations/FadeIn';
import { SlideUp } from './animations/SlideUp';

export default function Hero() {
  const { token } = useAuthData();
  const navigate = useNavigate();

  return (
    <div className="mb-8 flex max-w-3xl flex-1 flex-col justify-end text-slate-50">
      <FadeIn delay={100}>
        <h1 className="cursor-text text-2xl font-bold sm:text-4xl lg:text-5xl">
          {token ? 'Welcome Back, Explorer!' : 'Journey Beyond Horizons'}
        </h1>
      </FadeIn>
      
      <SlideUp delay={200}>
        <p className="my-4 cursor-text text-base sm:text-lg lg:text-xl">
          {token 
            ? 'Share your adventures with the world. Your stories inspire others to explore.'
            : 'Dive into the world of travel with stories that transport you to far-off lands. Adventure awaits around every corner. It\'s time to explore the world!'
          }
        </p>
      </SlideUp>
      
      {!token && (
        <SlideUp delay={300}>
          <button
            onClick={() => navigate('/signup')}
            className="active:scale-click w-fit rounded-lg bg-light-primary px-6 py-3 text-base font-semibold text-light hover:bg-light-primary/80 dark:bg-dark-primary dark:text-dark-card dark:hover:bg-dark-secondary/80 transition-all duration-200"
            aria-label="Get started with WanderLust"
          >
            Start Your Journey
          </button>
        </SlideUp>
      )}
      
      {token && (
        <SlideUp delay={300}>
          <p className="text-sm text-slate-300">
            Ready to share your next adventure?
          </p>
        </SlideUp>
      )}
    </div>
  );
}