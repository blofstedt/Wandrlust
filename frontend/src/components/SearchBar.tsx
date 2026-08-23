import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import axiosInstance from '@/helpers/axios-instance';
import { FadeIn } from './animations/FadeIn';

interface SearchBarProps {
  className?: string;
  placeholder?: string;
}

export default function SearchBar({ 
  className = '', 
  placeholder = 'Search blog posts...'
}: SearchBarProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);
  const navigate = useNavigate();
  const searchRef = useRef<HTMLDivElement>(null);

  const handleSearchChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const query = e.target.value;
    setSearchQuery(query);
    if (query.length > 2) {
      setIsSearching(true);
      try {
        const response = await axiosInstance.get('/api/posts/search', { params: { q: query } });
        setSearchResults(response.data);
        setShowResults(true);
      } catch (error) {
        console.error('Search error:', error);
      } finally {
        setIsSearching(false);
      }
    } else {
      setSearchResults([]);
      setShowResults(false);
    }
  };

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchQuery.trim()) {
      navigate(`/search?q=${encodeURIComponent(searchQuery)}`);
      setShowResults(false);
    }
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (searchRef.current && !searchRef.current.contains(event.target as Node)) {
        setShowResults(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') setShowResults(false);
  };

  return (
    <FadeIn delay={0} className=`relative ${className}`>
      <form onSubmit={handleSearchSubmit} className="w-full">
        <div className="relative">
          <input
            type="search"
            value={searchQuery}
            onChange={handleSearchChange}
            onKeyDown={handleKeyDown}
            onFocus={() => searchQuery.length > 2 && setShowResults(true)}
            placeholder={placeholder}
            className="w-full rounded-lg bg-light-field dark:bg-dark-field border border-light-border dark:border-dark-border text-light-primary dark:text-dark-primary placeholder:text-light-tertiary dark:placeholder:text-dark-tertiary p-3 pl-10 focus:outline-none focus:ring-2 focus:ring-brand-primary/50 transition-all duration-200"
            aria-label="Search blog posts"
            aria-autocomplete="list"
            aria-expanded={showResults}
          />
          <div className="absolute left-3 top-1/2 -translate-y-1/2">
            <svg className="h-5 w-5 text-light-tertiary dark:text-dark-tertiary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>
          {isSearching && (
            <div className="absolute right-3 top-1/2 -translate-y-1/2">
              <div className="h-4 w-4 animate-spin-slow rounded-full border-2 border-brand-primary border-r-transparent" />
            </div>
          )}
          {showResults && searchResults.length > 0 && (
            <div ref={searchRef} className="absolute left-0 right-0 top-full mt-2 z-50 rounded-lg bg-light dark:bg-dark-card shadow-lg border border-light-border dark:border-dark-border overflow-hidden" role="listbox">
              {searchResults.slice(0, 5).map((result: any, index) => (
                <button
                  key={result._id || index}
                  onClick={() => { navigate(`/details-page/${result.slug || result._id}`); setShowResults(false); setSearchQuery(''); }}
                  className="w-full p-3 text-left hover:bg-light-secondary/50 dark:hover:bg-dark-secondary/50 transition-colors duration-150 border-b border-light-border/50 dark:border-dark-border/50 last:border-0"
                  role="option"
                >
                  <div className="flex items-center gap-3">
                    {result.imageLink && <img src={result.imageLink} alt="" className="h-10 w-10 rounded object-cover" loading="lazy" />}
                    <div className="flex-1 min-w-0">
                      <div className="truncate font-medium text-light-primary dark:text-dark-primary">{result.title}</div>
                      <div className="text-sm text-light-tertiary dark:text-dark-tertiary line-clamp-1">{result.description}</div>
                    </div>
                  </div>
                </button>
              ))}
              <div className="p-3 text-center text-sm">
                <button onClick={() => { navigate(`/search?q=${encodeURIComponent(searchQuery)}`); setShowResults(false); }} className="text-brand-primary hover:text-brand-secondary">
                  View all results for "{searchQuery}"
                </button>
              </div>
            </div>
          )}
          {showResults && searchResults.length === 0 && !isSearching && (
            <div className="absolute left-0 right-0 top-full mt-2 rounded-lg bg-light dark:bg-dark-card shadow-lg border border-light-border dark:border-dark-border p-3">
              <div className="text-center text-sm text-light-tertiary dark:text-dark-tertiary">No posts found</div>
            </div>
          )}
        </div>
      </form>
    </FadeIn>
  );
}