const path = require('path');
require('dotenv').config({ quiet: true, path: path.join(__dirname, '..', '.env') });

const { startJobTimeoutSweep } = require('./services/jobTimeoutSweep');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');

const authRoutes = require('./routes/auth');
const toolsRoutes = require('./routes/tools');
const dashboardRoutes = require('./routes/dashboard');
const jobsRoutes = require('./routes/jobs');
const { errorHandler } = require('./middleware/errorHandler');
const bulkRoutes = require('./routes/bulk');
const apiKeyRoutes = require('./routes/apiKey');
const billingWebhookRoutes = require('./routes/billingWebhook');
const billingRoutes = require('./routes/billing');

const app = express();

// Hostinger (like most hosting platforms) sits the app behind a reverse
// proxy, which adds an X-Forwarded-For header showing the real visitor
// IP. Without this setting, express-rate-limit can't reliably tell
// visitors apart by IP, and Express logs a warning about it.
app.set('trust proxy', 1);
const PORT = process.env.PORT || 4000;

// CRITICAL: the billing webhook route must be mounted here, BEFORE
// express.json() below — signature verification needs the exact raw
// bytes Lemon Squeezy signed. If express.json() runs first, it consumes
// the request body, and by the time the webhook route's own
// express.raw() middleware runs there's nothing left to capture
// (confirmed directly in testing: req.body would already be a parsed
// object, not a Buffer, breaking the signature check entirely).
app.use('/api/billing', billingWebhookRoutes);

// Default helmet CSP only allows images from 'self' and data: — this was
// silently blocking every tool result: local before/after previews use
// blob: URLs, and Replicate's actual output images are served from
// replicate.delivery. Both need to be explicitly allowed.
app.use(helmet({
  crossOriginResourcePolicy: false,
  contentSecurityPolicy: {
    directives: {
      ...helmet.contentSecurityPolicy.getDefaultDirectives(),
      'img-src': ["'self'", 'data:', 'blob:', 'https://replicate.delivery']
    }
  }
}));
app.use(cors({
  origin: process.env.PUBLIC_BASE_URL || 'http://localhost:4000'
}));

// Cap request body size — without a limit, express.json() will accept
// arbitrarily large payloads on every route.
app.use(express.json({ limit: '1mb' }));

// Serve the static frontend (client/) so the whole app can run from one server locally
// Clean URL routes — map pretty paths (e.g. /background-remover) to the
// actual HTML files living in client/pages, so visitors and search
// engines never see the real /pages/xxx.html file structure.
const cleanUrlMap = {
  '/': 'index.html',
  '/background-remover': 'bg-remove.html',
  '/upscale': 'upscale.html',
  '/watermark-remover': 'watermark-remove.html',
  '/expand': 'expand.html',
  '/recolor': 'recolor.html',
  '/svg-converter': 'svg-converter.html',
  '/vectorize': 'vectorize.html',
  '/bulk': 'bulk.html',
  '/pricing': 'pricing.html',
  '/api-docs': 'api-docs.html',
  '/blog': 'blogs.html',
  '/blog/how-to-expand-any-image-beyond-its-original-frame': 'blog-expand-image.html',
  '/blog/how-ai-background-removers-are-changing-the-way-designers-work': 'blog-bg-remove-designers.html',
  '/blog/how-to-upscale-images-using-ai': 'blog-upscale-images.html',
  '/blog/how-to-convert-a-jpg-logo-to-vector-without-losing-quality': 'blog-jpg-to-vector.html',
  '/contact': 'contact.html',
  '/privacy-policy': 'privacy-policy.html',
  '/terms-of-service': 'terms-of-service.html',
  '/dashboard': 'dashboard.html',
  '/login': 'login.html',
  '/signup': 'signup.html',
  '/oauth-complete': 'oauth-complete.html'
};

for (const [cleanPath, realFile] of Object.entries(cleanUrlMap)) {
  app.get(cleanPath, (req, res) => {
    const filePath = path.join(__dirname, '..', 'client', 'pages', realFile);
    res.sendFile(filePath, (err) => {
      if (err) {
        console.error(`[clean-url diagnostic] Failed to serve "${req.path}" -> expected file: ${filePath}`);
        // sendFile's callback fires on failure even after headers may
        // have been partially sent; only respond if we still can, so we
        // never leave the client hanging with no response at all.
        if (!res.headersSent) {
          res.status(404).send('Not found');
        }
      }
    });
  });
}

app.use(express.static(path.join(__dirname, '..', 'client')));

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api', generalLimiter);

app.use('/api/auth', authRoutes);
app.use('/api/tools', toolsRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/jobs', jobsRoutes);
app.use('/api/tools', bulkRoutes);
app.use('/api', bulkRoutes);
app.use('/api/api-key', apiKeyRoutes);
app.use('/api/billing', billingRoutes);

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use(errorHandler);

// Single startup block — a second, duplicate app.listen() here previously
// would have tried to bind the same port twice and crashed with
// EADDRINUSE the moment the server started.
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`PixelForge API listening on port ${PORT}`);
  });
  startJobTimeoutSweep();
}

module.exports = app;