import React, { useState, useRef, useCallback } from 'react';
import {
  Box,
  Paper,
  Typography,
  LinearProgress,
  Alert,
  styled
} from '@mui/material';
import { CloudUpload } from '@mui/icons-material';
import { prepareImage } from '../prepareImage.ts';

const UploadBox = styled(Paper)(({ theme }) => ({
  border: `2px dashed ${theme.palette.divider}`,
  borderRadius: theme.shape.borderRadius,
  padding: theme.spacing(3),
  textAlign: 'center',
  cursor: 'pointer',
  transition: 'border-color 0.3s ease',
  '&:hover': {
    borderColor: theme.palette.primary.main,
  },
  '&.dragover': {
    borderColor: theme.palette.primary.main,
    backgroundColor: theme.palette.action.hover,
  }
}));

const HiddenInput = styled('input')({
  display: 'none',
});

interface FileUploadProps {
  onImageUploaded: (imageId: string) => void;
}

const FileUpload: React.FC<FileUploadProps> = ({ onImageUploaded }) => {
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const uploadFile = useCallback(async (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          const imageData = await prepareImage(reader.result as string, file.size);

          const response = await fetch('/upload', {
            body: imageData,
            method: 'POST',
            headers: {
              'Content-Type': 'text/plain'
            }
          });

          const imageId = await response.text();

          if (!response.ok || !/^[a-z]{32}$/.test(imageId)) {
            reject(new Error(!response.ok ? imageId || 'Upload failed' : 'Upload failed'));
          } else {
            resolve(imageId);
          }
        } catch (error) {
          reject(error);
        }
      };
      reader.onerror = () => reject(new Error('File read failed'));
      reader.readAsDataURL(file);
    });
  }, []);

  const handleUpload = useCallback(async (files: FileList) => {
    if (files.length === 0) return;

    setUploading(true);
    setError(null);
    setSuccess(null);
    setUploadProgress(0);

    try {
      const fileArray = Array.from(files);
      const totalFiles = fileArray.length;

      // Upload files in parallel
      const uploadPromises = fileArray.map(async (file, index) => {
        const imageId = await uploadFile(file);
        onImageUploaded(imageId);
        setUploadProgress(((index + 1) / totalFiles) * 100);
        return imageId;
      });

      await Promise.all(uploadPromises);

      setSuccess(`Successfully uploaded ${totalFiles} file(s)!`);
      setTimeout(() => setSuccess(null), 3000);
    } catch (error) {
      console.error('Upload error:', error);
      setError(error instanceof Error ? error.message : 'Upload failed. Please try again.');
      setTimeout(() => setError(null), 5000);
    } finally {
      setUploading(false);
      setUploadProgress(0);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [uploadFile, onImageUploaded]);

  const handleFileSelect = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      handleUpload(event.target.files);
    }
  };

  const handleDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragOver(false);

    if (event.dataTransfer.files) {
      handleUpload(event.dataTransfer.files);
    }
  };

  const handleDragOver = (event: React.DragEvent) => {
    event.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = () => {
    setDragOver(false);
  };

  const handleClick = () => {
    fileInputRef.current?.click();
  };

  // Handle paste events
  React.useEffect(() => {
    const handlePaste = async (event: ClipboardEvent) => {
      const items = event.clipboardData?.items;
      if (!items) return;

      const imageFiles: File[] = [];
      for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf('image') !== -1) {
          const file = items[i].getAsFile();
          if (file) {
            imageFiles.push(file);
          }
        }
      }

      if (imageFiles.length > 0) {
        const fileList = new DataTransfer();
        imageFiles.forEach(file => fileList.items.add(file));
        await handleUpload(fileList.files);
      }
    };

    window.addEventListener('paste', handlePaste);
    return () => window.removeEventListener('paste', handlePaste);
  }, [handleUpload]);

  return (
    <Box sx={{ mb: 4 }}>
      <HiddenInput
        ref={fileInputRef}
        type="file"
        multiple
        accept="image/*"
        onChange={handleFileSelect}
      />

      <UploadBox
        className={dragOver ? 'dragover' : ''}
        onClick={handleClick}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        elevation={0}
      >
        <CloudUpload sx={{ fontSize: 48, color: 'text.secondary', mb: 2 }} />
        <Typography variant="h6" gutterBottom>
          {uploading ? 'Uploading...' : 'Upload Images'}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Click to select files, drag & drop, or paste images
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={{ mt: 1, display: 'block' }}>
          Uploaded images are automatically deleted after 7 days without being accessed.
        </Typography>

        {uploading && (
          <Box sx={{ mt: 2, width: '100%' }}>
            <LinearProgress variant="determinate" value={uploadProgress} />
            <Typography variant="body2" sx={{ mt: 1 }}>
              {Math.round(uploadProgress)}% complete
            </Typography>
          </Box>
        )}
      </UploadBox>

      {error && (
        <Alert severity="error" sx={{ mt: 2 }}>
          {error}
        </Alert>
      )}

      {success && (
        <Alert severity="success" sx={{ mt: 2 }}>
          {success}
        </Alert>
      )}
    </Box>
  );
};

export default FileUpload;
