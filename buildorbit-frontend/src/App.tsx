import { BrowserRouter, Routes, Route } from 'react-router-dom';
import Shell from './components/Shell/Shell';
import Dashboard from './routes/Dashboard';
import NewBuild from './routes/NewBuild';
import History from './routes/History';
import Run from './routes/Run';
import Settings from './routes/Settings';
import Admin from './routes/Admin';
import NotFound from './routes/NotFound';
import Overview from './routes/Overview';
import Videos from './routes/Videos';

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/overview" element={<Overview />} />
        <Route path="/videos" element={<Videos />} />
        <Route element={<Shell />}>
          <Route path="/" element={<Dashboard />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/new" element={<NewBuild />} />
          <Route path="/history" element={<History />} />
          <Route path="/run/:id" element={<Run />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/api-keys" element={<Settings />} />
          <Route path="/admin" element={<Admin />} />
          <Route path="*" element={<NotFound />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
