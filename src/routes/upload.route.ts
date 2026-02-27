import { Router, Request, Response } from 'express';
import multer from 'multer';
import { v2 as cloudinary } from 'cloudinary';
import fs from 'fs';

// Cloudinary config
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Configure multer to save files temporarily
const upload = multer({ dest: '/tmp/' });

const router = Router();

router.post('/upload-image', upload.single('image'), async (req: Request, res: Response): Promise<void> => {
    try {
        if (!req.file) {
            res.status(400).json({ status: 'error', message: 'No file uploaded' });
            return;
        }

        const filePath = req.file.path;

        // Upload to Cloudinary
        const result = await cloudinary.uploader.upload(filePath, {
            folder: 'rpn-finance', // consistent naming
            resource_type: 'image',
        });

        // Delete local temp file
        fs.unlinkSync(filePath);

        res.json({
            status: 'ok',
            imageUrl: result.secure_url,
            publicId: result.public_id,
        });
    } catch (error) {
        console.error('Cloudinary upload error:', error);
        res.status(500).json({ status: 'error', message: 'Upload failed' });
    }
});

export default router;
