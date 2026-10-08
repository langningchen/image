import React, { useState, useRef, useCallback } from 'react';
import {
  Box,
  Paper,
  Typography,
  LinearProgress,
  Alert,
  TextField,
  styled
} from '@mui/material';
import { CloudUpload } from '@mui/icons-material';
import { prepareImage } from '../prepareImage.ts';
import { CONSENT_HEADER, TERMS_VERSION } from '../../terms.ts';
import { IMAGE_ID_PATTERN } from '../../worker/constants.ts';

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
  const [uploadPassword, setUploadPassword] = useState('');
  const [passwordRequired, setPasswordRequired] = useState(false);
  const [retentionDays, setRetentionDays] = useState<number | null>(null);
  React.useEffect(() => { void fetch('/api/config').then(response => response.json()).then(config => { setRetentionDays(config.retentionDays); setPasswordRequired(config.uploadPasswordRequired); }).catch(() => {}); }, []);
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
              'Content-Type': 'text/plain',
              ...(uploadPassword ? { 'X-Upload-Password': uploadPassword } : {}),
              [CONSENT_HEADER]: TERMS_VERSION,
            }
          });

          const imageId = await response.text();

          if (!response.ok || !IMAGE_ID_PATTERN.test(imageId)) {
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
  }, [uploadPassword]);

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
      {passwordRequired && <TextField type="password" label="Upload password" value={uploadPassword} onChange={event => setUploadPassword(event.target.value)} disabled={uploading} autoComplete="off" fullWidth sx={{ mb: 2 }} helperText="Enter the upload password provided by the site operator." />}
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
          {retentionDays === null ? 'Images expire after the configured inactivity period.' : `Uploaded images are automatically deleted after ${retentionDays} days without being accessed.`}
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
