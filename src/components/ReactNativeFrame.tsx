import React from 'react';
import { Compass, Map, List, Bookmark, Plug, Battery, Signal, Smartphone } from 'lucide-react';

interface ReactNativeFrameProps {
  isMobileFrame: boolean;
  activeTab: 'map' | 'list' | 'saved';
  onTabChange: (tab: 'map' | 'list' | 'saved') => void;
  savedCount: number;
  children: React.ReactNode;
}

export const ReactNativeFrame: React.FC<ReactNativeFrameProps> = ({
  isMobileFrame,
  activeTab,
  onTabChange,
  savedCount,
  children
}) => {
  if (!isMobileFrame) {
    return <div className="w-full h-full flex flex-col flex-1">{children}</div>;
  }

  return (
    <div className="w-full min-h-screen bg-slate-950 flex items-center justify-center p-2 sm:p-6 overflow-hidden">
      {/* Mobile Device Mockup Frame */}
      <div className="relative w-full max-w-[410px] h-[830px] bg-slate-900 rounded-[50px] border-[10px] border-slate-800 shadow-2xl flex flex-col overflow-hidden ring-1 ring-slate-700">
        {/* Mobile Top Notch & Status Bar */}
        <div className="bg-slate-900 px-6 pt-3 pb-2 flex items-center justify-between text-[11px] text-slate-300 font-semibold select-none border-b border-slate-800/50 z-[1100]">
          <span>9:41</span>
          {/* Simulated Dynamic Island Notch */}
          <div className="w-24 h-4 bg-slate-950 rounded-full border border-slate-800 flex items-center justify-center">
            <div className="w-2.5 h-2.5 rounded-full bg-slate-800 mr-2" />
            <div className="w-1.5 h-1.5 rounded-full bg-emerald-500/80" />
          </div>
          <div className="flex items-center gap-1.5 text-slate-400">
            <Signal className="w-3 h-3 text-emerald-400" />
            <Plug className="w-3 h-3 text-emerald-400" />
            <Battery className="w-3.5 h-3.5 text-emerald-400" />
          </div>
        </div>

        {/* Content Viewport */}
        <div className="flex-1 relative flex flex-col overflow-hidden bg-slate-950">
          {children}
        </div>

        {/* React Native Bottom Tab Bar */}
        <div className="bg-slate-900 border-t border-slate-800/90 px-4 py-2 flex items-center justify-around z-[1100] text-[10px] font-bold">
          <button
            onClick={() => onTabChange('map')}
            className={`flex flex-col items-center gap-1 py-1 px-4 rounded-xl transition-all ${
              activeTab === 'map' ? 'text-emerald-400' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Map className="w-5 h-5" />
            <span>Explorer Map</span>
          </button>

          <button
            onClick={() => onTabChange('list')}
            className={`flex flex-col items-center gap-1 py-1 px-4 rounded-xl transition-all ${
              activeTab === 'list' ? 'text-emerald-400' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <List className="w-5 h-5" />
            <span>Sites List</span>
          </button>

          <button
            onClick={() => onTabChange('saved')}
            className={`relative flex flex-col items-center gap-1 py-1 px-4 rounded-xl transition-all ${
              activeTab === 'saved' ? 'text-emerald-400' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            <Bookmark className="w-5 h-5" />
            <span>Saved Sites</span>
            {savedCount > 0 && (
              <span className="absolute top-0 right-3 w-4 h-4 rounded-full bg-amber-500 text-slate-950 text-[9px] font-extrabold flex items-center justify-center">
                {savedCount}
              </span>
            )}
          </button>
        </div>

        {/* Bottom Swipe Indicator Bar */}
        <div className="bg-slate-900 pb-1 flex justify-center">
          <div className="w-32 h-1 rounded-full bg-slate-700" />
        </div>
      </div>
    </div>
  );
};


