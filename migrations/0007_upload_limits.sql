CREATE TABLE upload_settings (
    id INTEGER PRIMARY KEY CHECK(id = 1),
    max_image_dimension INTEGER CHECK(max_image_dimension IS NULL OR max_image_dimension > 0),
    max_upload_bytes INTEGER CHECK(max_upload_bytes IS NULL OR max_upload_bytes > 0)
);

INSERT INTO upload_settings (id, max_image_dimension, max_upload_bytes)
VALUES (1, 1920, 10485760);
