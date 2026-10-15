import '@fontsource/open-sans/300.css';
import '@fontsource/open-sans/400.css';
import '@fontsource/open-sans/600.css';
import '@fontsource/open-sans/700.css';
import '@fontsource/lato/300.css';
import '@fontsource/lato/400.css';
import './base.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { Header } from './Header.tsx';
import Room from './pages/Room.tsx';
import Start from './pages/Start.tsx';
import { UiProvider } from './ui.tsx';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <UiProvider>
        <Header />
        <Routes>
          <Route path="/" element={<Start />} />
          <Route path="/rooms/:id" element={<Room />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </UiProvider>
    </BrowserRouter>
  </StrictMode>,
);
