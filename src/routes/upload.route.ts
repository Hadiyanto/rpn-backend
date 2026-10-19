import { Router, Request, Response, NextFunction } from 'express';
import multer from 'multer';
import rateLimit from 'express-rate-limit';
import { v2 as cloudinary } from 'cloudinary';
import fs from 'fs';

// Cloudinary config
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

// Temp files on disk; images only, max 5 MB (the endpoint is public — used by the bukti-transfer page).
const upload = multer({
    dest: '/tmp/',
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => cb(null, file.mimetype.startsWith('image/')),
});

const router = Router();

const receiveImage = (req: Request, res: Response, next: NextFunction) =>
    upload.single('image')(req, res, (err: unknown) => {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
            res.status(400).json({ status: 'error', message: 'Ukuran gambar maksimal 5 MB' });
            return;
        }
        if (err) {
            next(err);
            return;
        }
        next();
    });

// The endpoint is public (transfer proofs), so cap guests: every upload is stored on Cloudinary
// (review 2026-10-19, I2). Logged-in staff (expense receipts, flavor photos) are not limited.
const uploadLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 20,
    skip: req => !!req.user,
    message: { status: 'error', message: 'Terlalu banyak upload. Coba lagi 15 menit lagi.' },
    standardHeaders: true,
    legacyHeaders: false,
});

router.post('/upload-image', uploadLimiter, receiveImage, async (req: Request, res: Response): Promise<void> => {
    const filePath = req.file?.path;
    try {
        if (!req.file || !filePath) {
            res.status(400).json({ status: 'error', message: 'File gambar wajib diunggah (jpg/png/webp)' });
            return;
        }

        // Upload to Cloudinary
        const result = await cloudinary.uploader.upload(filePath, {
            folder: 'rpn-finance', // consistent naming
            resource_type: 'image',
        });

        res.json({
            status: 'ok',
            imageUrl: result.secure_url,
            publicId: result.public_id,
        });
    } catch (error) {
        console.error('Cloudinary upload error:', error);
        res.status(500).json({ status: 'error', message: 'Upload failed' });
    } finally {
        // Always remove the temp file, also when the Cloudinary upload failed.
        if (filePath) await fs.promises.unlink(filePath).catch(() => undefined);
    }
});

export default router;
