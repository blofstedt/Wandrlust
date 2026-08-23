import React from 'react';
import ReactDOM from 'react-dom/client';
import App from '@/App.tsx';
import '@/index.css';
import { ToastContainer } from 'react-toastify';
import 'react-toastify/dist/ReactToastify.css';

const loadFont = () => {
  const link = document.createElement('link');
  link.href = 'https://fonts.googleapis.com/css2?family=Poppins:wght@400;500;600;700&display=swap';
  link.rel = 'stylesheet';
  link.type = 'text/css';
  document.head.appendChild(link);
};

loadFont();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
    <ToastContainer 
      position="top-right" 
      autoClose={5000} 
      hideProgressBar={false} 
      newestOnTop={false} 
      closeOnClick 
      rtl={false} 
      pauseOnFocusLoss 
      draggable 
      pauseOnHover 
      theme="light"
    />
  </React.StrictMode>
);