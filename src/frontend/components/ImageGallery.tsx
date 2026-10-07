import React, { useState } from 'react';
import {
  Grid,
  Card,
  CardMedia,
  CardActions,
  Button,
  Box,
  Snackbar,
  Alert,
  Dialog,
  DialogTitle,
  DialogContent,
  DialogContentText,
  DialogActions
} from '@mui/material';
import {
  ContentCopy,
  Delete,
  Link as LinkIcon
} from '@mui/icons-material';

interface ImageGalleryProps {
  images: string[];
  onImageDeleted: (imageId: string) => void;
}

const ImageGallery: React.FC<ImageGalleryProps> = ({ images, onImageDeleted }) => {
  const [snackbar, setSnackbar] = useState<{
    open: boolean;
    message: string;
    severity: 'success' | 'error';
  }>({
    open: false,
    message: '',
    severity: 'success'
  });

  const [deleteDialog, setDeleteDialog] = useState<{
    open: boolean;
    imageId: string | null;
  }>({
    open: false,
    imageId: null
  });

  const copyToClipboard = async (text: string, type: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setSnackbar({
        open: true,
        message: `${type} copied to clipboard!`,
        severity: 'success'
      });
    } catch (error) {
      setSnackbar({
        open: true,
        message: 'Failed to copy to clipboard',
        severity: 'error'
      });
    }
  };

  const handleCopyUrl = (imageId: string) => {
    const url = `${window.location.origin}/${imageId}`;
    copyToClipboard(url, 'URL');
  };

  const handleCopyMarkdown = (imageId: string) => {
    const markdown = `![image](${window.location.origin}/${imageId})`;
    copyToClipboard(markdown, 'Markdown');
  };

  const handleDeleteClick = (imageId: string) => {
    setDeleteDialog({
      open: true,
      imageId
    });
  };

  const handleDeleteConfirm = () => {
    if (deleteDialog.imageId) {
      onImageDeleted(deleteDialog.imageId);
      setSnackbar({
        open: true,
        message: 'Image deleted successfully',
        severity: 'success'
      });
    }
    setDeleteDialog({
      open: false,
      imageId: null
    });
  };

  const handleDeleteCancel = () => {
    setDeleteDialog({
      open: false,
      imageId: null
    });
  };

  const handleSnackbarClose = () => {
    setSnackbar(prev => ({ ...prev, open: false }));
  };

  if (images.length === 0) {
    return null;
  }

  return (
    <Box>
      <Grid container spacing={3}>
        {images.map((imageId) => (
          <Grid size={{ xs: 12, sm: 6, md: 4, lg: 3 }} key={imageId}>
            <Card sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
              <CardMedia
                component="img"
                sx={{
                  height: 200,
                  objectFit: 'cover'
                }}
                image={`/${imageId}?search`}
                alt="Uploaded image"
                loading="lazy"
                onError={(e) => {
                  const target = e.target as HTMLImageElement;
                  target.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect width='100' height='100' fill='%23ddd'/%3E%3Ctext x='50' y='50' text-anchor='middle' dy='.3em'%3EError%3C/text%3E%3C/svg%3E";
                }}
              />
              <CardActions sx={{ justifyContent: 'center', gap: 1, flexWrap: 'wrap' }}>
                <Button
                  size="small"
                  startIcon={<LinkIcon />}
                  onClick={() => handleCopyUrl(imageId)}
                >
                  URL
                </Button>
                <Button
                  size="small"
                  startIcon={<ContentCopy />}
                  onClick={() => handleCopyMarkdown(imageId)}
                >
                  Markdown
                </Button>
                <Button
                  size="small"
                  color="error"
                  startIcon={<Delete />}
                  onClick={() => handleDeleteClick(imageId)}
                >
                  Delete
                </Button>
              </CardActions>
            </Card>
          </Grid>
        ))}
      </Grid>

      {/* Delete confirmation dialog */}
      <Dialog
        open={deleteDialog.open}
        onClose={handleDeleteCancel}
        aria-labelledby="delete-dialog-title"
        aria-describedby="delete-dialog-description"
      >
        <DialogTitle id="delete-dialog-title">
          Confirm Deletion
        </DialogTitle>
        <DialogContent>
          <DialogContentText id="delete-dialog-description">
            Are you sure you want to delete this image? Please note that only the image ID will be removed from the gallery, and the actual image file will remain on the server.
          </DialogContentText>
        </DialogContent>
        <DialogActions>
          <Button onClick={handleDeleteCancel}>Cancel</Button>
          <Button onClick={handleDeleteConfirm} color="error" autoFocus>
            Delete
          </Button>
        </DialogActions>
      </Dialog>

      {/* Snackbar for notifications */}
      <Snackbar
        open={snackbar.open}
        autoHideDuration={3000}
        onClose={handleSnackbarClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert onClose={handleSnackbarClose} severity={snackbar.severity}>
          {snackbar.message}
        </Alert>
      </Snackbar>
    </Box>
  );
};

export default ImageGallery;
