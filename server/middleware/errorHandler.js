const multer = require('multer');

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, next) {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ success: false, error: 'File is too large — the maximum allowed size is 15MB. Try compressing the image or using a smaller resolution.' });
    }
    return res.status(400).json({ success: false, error: err.message });
  }
  if (err.message?.includes('Unsupported file type')) {
    return res.status(400).json({ success: false, error: err.message });
  }
  console.error(err);
  res.status(500).json({ success: false, error: 'Internal server error' });
}

module.exports = { errorHandler };