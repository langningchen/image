import React, { useState, useEffect } from 'react';
import {
  Container,
  Typography,
  Box,
  CssBaseline,
  ThemeProvider,
  createTheme,
  Link,
  Divider
} from '@mui/material';
import FileUpload from './components/FileUpload';
import ImageGallery from './components/ImageGallery';
import UploadConsent from './components/UploadConsent';
import { TERMS_VERSION } from '../terms.ts';

const theme = createTheme({
  palette: {
    mode: 'light',
    primary: {
      main: '#1976d2',
    },
  },
});

const App: React.FC = () => {
  const [images, setImages] = useState<string[]>([]);
  const [consented, setConsented] = useState(() => {
    try { return localStorage.getItem('acceptedTermsVersion') === TERMS_VERSION; }
    catch { return false; }
  });

  useEffect(() => {
    // Load existing images from localStorage
    const storedImages = localStorage.getItem('images');
    if (storedImages) {
      setImages(storedImages.split(',').filter(Boolean).reverse());
    }

    // Register service worker for enhanced caching
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js')
        .then(registration => console.log('SW registered:', registration))
        .catch(error => console.log('SW registration failed:', error));
    }
  }, []);

  const handleImageUploaded = (imageId: string) => {
    setImages(prevImages => [imageId, ...prevImages]);
    // Update localStorage
    const currentImages = localStorage.getItem('images')?.split(',').filter(Boolean) || [];
    const updatedImages = [imageId, ...currentImages];
    localStorage.setItem('images', updatedImages.join(','));
  };

  const handleImageDeleted = (imageId: string) => {
    setImages(prevImages => prevImages.filter(id => id !== imageId));
    // Update localStorage
    const currentImages = localStorage.getItem('images')?.split(',').filter(Boolean) || [];
    const updatedImages = currentImages.filter(id => id !== imageId);
    localStorage.setItem('images', updatedImages.join(','));
  };

  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <Container maxWidth="lg" sx={{ mt: 3 }}>
        <Typography variant="h4" component="h1" gutterBottom>
          Image
        </Typography>
        
        <Divider sx={{ mb: 3 }} />
        
        <Box sx={{ mb: 3 }}>
          <Typography variant="body1" component="p" sx={{ mb: 2 }}>
            This is an image hosting service.
            Just paste in your image or select your image below, and you will get a URL in a few seconds!
          </Typography>
          
          <Typography variant="body1" component="p" sx={{ mb: 2 }}>
            This project is created by{' '}
            <Link href="https://github.com/langningchen" target="_blank" rel="noopener">
              Langning Chen
            </Link>
            {' '}for learning and communication purposes only. It is open sourced on{' '}
            <Link href="https://github.com/langningchen/image" target="_blank" rel="noopener">
              GitHub
            </Link>
            {' '}and licensed under{' '}
            <Link href="https://github.com/langningchen/image/blob/main/LICENSE" target="_blank" rel="noopener">
              GPL-3.0
            </Link>
            .
          </Typography>
        </Box>

        {consented ? <FileUpload onImageUploaded={handleImageUploaded} /> : <UploadConsent onAccept={() => {
          try { localStorage.setItem('acceptedTermsVersion', TERMS_VERSION); } catch { /* Allow consent for this session. */ }
          setConsented(true);
        }} />}
        <Typography variant="body2" sx={{ mb: 3 }}>
          Built with Llama · <Link href="/terms.html" target="_blank" rel="noopener">Terms of Service</Link>
          {consented && <> · <Link component="button" type="button" sx={{ verticalAlign: 'baseline' }} onClick={() => {
            try { localStorage.removeItem('acceptedTermsVersion'); } catch { /* Session state still resets. */ }
            setConsented(false);
          }}>Review consent</Link></>}
        </Typography>
        
        <ImageGallery images={images} onImageDeleted={handleImageDeleted} />
      </Container>
    </ThemeProvider>
  );
};

export default App;
