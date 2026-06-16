import axios from 'axios';

// Consumed as source by each Vite app, so import.meta.env resolves in the
// consuming app's build. Set VITE_API_BASE_URL per app (.env).
const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:3002/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

export default api;
