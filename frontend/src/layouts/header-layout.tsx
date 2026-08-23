import ThemeToggle from '@/components/theme-toggle-button';
import AddIcon from '@/assets/svg/add-icon-white.svg';
import LogOutIcon from '@/assets/svg/logout-icon.svg';
import LogInIcon from '@/assets/svg/login-icon.svg';
import AppIcon from '@/assets/svg/app-icon.svg';
import { useNavigate } from 'react-router-dom';
import Hero from '@/components/hero';
import { AxiosError, isAxiosError } from 'axios';
import { toast } from 'react-toastify';
import axiosInstance from '@/helpers/axios-instance';
import Loader from '@/components/skeletons/loader';
import useAuthData from '@/hooks/useAuthData';
import userState from '@/utils/user-state';
import { Link } from 'react-router-dom';
import { Role } from '@/types/role-type.tsx';

function Header() {
  const navigate = useNavigate();
  const { token, loading } = useAuthData();
  const user = userState.getUser();

  const handleLogout = async () => {
    try {
      const response = await axiosInstance.post('/api/auth/signout');
      toast.promise(response, {
        pending: 'Signing out...',
        success: {
          render({ data }) {
            userState.removeUser();
            navigate('/');
            return data?.data?.message || 'Signed out successfully';
          },
        },
        error: {
          render({ data }) {
            if (data instanceof AxiosError) {
              if (data?.response?.data?.message) {
                return data?.response?.data?.message;
              }
            }
            return 'Signout failed';
          },
        },
      });
    } catch (error) {
      if (isAxiosError(error)) {
        console.error(error.response?.data?.message || 'An error occurred during signout');
      } else {
        console.error('Signout error:', error);
      }
      toast.error('Failed to sign out. Please try again.');
    }
  };

  return (
    <header className="relative -mt-2 h-[460px] bg-[url('./assets/wanderlustbg.webp')] bg-cover bg-fixed bg-center">
      <div className="absolute inset-0 bg-black opacity-50"></div>
      <nav className="absolute inset-0 flex flex-col px-8 py-8 text-slate-50 sm:px-16">
        <div className="flex w-full justify-between">
          <div className="flex cursor-text items-center justify-between gap-2 text-2xl font-semibold">
            <Link to="/"><img src={AppIcon} className="h-10 w-10" alt="WanderLust Logo" /></Link>
            <Link to="/" style={{ textDecoration: 'none' }}>WanderLust</Link>
          </div>
          <div className="flex items-center justify-between">
            <div className="flex items-center justify-end px-4 sm:px-20"><ThemeToggle /></div>
            <div>
              {loading ? (
                <Loader />
              ) : token ? (
                <div className="flex gap-2">
                  {user?.role === Role.Admin && (
                    <button className="active:scale-click hidden rounded border border-slate-50 px-4 py-2 hover:bg-slate-500/25 md:inline-block" onClick={() => navigate('/admin/blogs')} aria-label="Dashboard">Dashboard</button>
                  )}
                  <button className="active:scale-click hidden rounded border border-slate-50 px-4 py-2 hover:bg-slate-500/25 md:inline-block" onClick={() => navigate('/add-blog')} aria-label="Create post">Create post</button>
                  <button className="active:scale-click hidden rounded border border-slate-50 px-4 py-2 hover:bg-slate-500/25 md:inline-block" onClick={handleLogout} aria-label="Logout">Logout</button>
                  <button className="px-2 py-2 hover:bg-slate-500/25 md:hidden" onClick={() => navigate('/add-blog')} aria-label="Create post"><img className="h-10 w-10" src={AddIcon} alt="Add Icon" /></button>
                  <button className="py-2 hover:bg-slate-500/25 md:hidden md:px-2" onClick={handleLogout} aria-label="Logout"><img className="h-9 w-9" src={LogOutIcon} alt="Logout Icon" /></button>
                </div>
              ) : (
                <div className="flex">
                  <button className="active:scale-click hidden rounded border border-slate-50 px-4 py-2 hover:bg-slate-500/25 md:inline-block" onClick={() => navigate('/signin')} aria-label="Login">Login</button>
                  <button className="py-2 hover:bg-slate-500/25 md:hidden md:px-2" onClick={() => navigate('/signin')} aria-label="Login"><img className="h-9 w-9" src={LogInIcon} alt="Login Icon" /></button>
                </div>
              )}
            </div>
          </div>
        </div>
        <Hero />
      </nav>
    </header>
  );
}

export default Header;