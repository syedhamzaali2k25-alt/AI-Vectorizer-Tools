const multer = require('multer');

const MAX_FILE_BYTES = 15 * 1024 * 1024; // 15MB
const ALLOWED_MIME = ['image/png', 'image/jpeg', 'image/webp'];

// Bulk uploads: same per-file limit, plus a cap on how many files can go
// in one batch — without this, someone could submit an enormous batch in
// one request and fire off dozens of concurrent Replicate calls at once.
const MAX_BATCH_FILES = 10;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES },
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}. Use PNG, JPG, or WebP.`));
    }
    cb(null, true);
  }
});

// For tools needing both a source image and a mask (e.g. Image Expander)
const uploadWithMask = upload.fields([
  { name: 'image', maxCount: 1 },
  { name: 'mask', maxCount: 1 }
]);

// For bulk/batch processing — multiple independent images in one request
const uploadBulk = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: MAX_BATCH_FILES },
  fileFilter(req, file, cb) {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new Error(`Unsupported file type: ${file.mimetype}. Use PNG, JPG, or WebP.`));
    }
    cb(null, true);
  }
}).array('images', MAX_BATCH_FILES);

module.exports = { upload, uploadWithMask, uploadBulk, MAX_BATCH_FILES };