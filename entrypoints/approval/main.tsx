import React from 'react';
import ReactDOM from 'react-dom/client';
import { ApprovalPage } from './ApprovalPage';
import '../popup/style.css';
import './approval.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ApprovalPage />
  </React.StrictMode>,
);
