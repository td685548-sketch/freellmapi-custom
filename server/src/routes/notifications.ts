import { Router, type Request, type Response } from 'express';
import type { SessionUser } from '../services/auth.js';
import {
  clearReadNotifications,
  listUserNotifications,
  markAllNotificationsRead,
  markNotificationRead,
} from '../services/in-app-notifications.js';

export const userNotificationsRouter = Router();

userNotificationsRouter.get('/notifications', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const limitRaw = typeof req.query.limit === 'string' ? Number(req.query.limit) : 40;
  const limit = Number.isFinite(limitRaw) ? limitRaw : 40;
  res.json(listUserNotifications(user.userId, limit));
});

userNotificationsRouter.post('/notifications/read-all', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  res.json(markAllNotificationsRead(user.userId));
});

userNotificationsRouter.post('/notifications/:id/read', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    res.status(400).json({ error: { message: 'Invalid notification ID.' } });
    return;
  }
  res.json(markNotificationRead(user.userId, id));
});

userNotificationsRouter.delete('/notifications/read', (req: Request, res: Response) => {
  const user = (req as Request & { user?: SessionUser }).user!;
  res.json(clearReadNotifications(user.userId));
});
