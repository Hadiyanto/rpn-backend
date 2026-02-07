import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import healthRouter from './health';
import apiRoutes from './routes';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors({
    origin: ["http://localhost:3000", "http://192.168.18.52:3000", "https://rt-finance-frontend.vercel.app"],
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE"],
    credentials: true,
}));

app.use(express.json());

app.use('/', healthRouter);
app.use('/api', apiRoutes);




app.listen(port, () => {
    console.log(`[server]: Server is running at http://localhost:${port}`);
});

export default app;
