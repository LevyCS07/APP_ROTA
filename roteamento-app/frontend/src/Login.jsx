import { useState } from 'react';
import { api, setToken } from './api.js';

export default function Login({ onSuccess }) {
  const [token, setTokenInput] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e) {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      await api.checkAuth(token);
      setToken(token);
      onSuccess();
    } catch (err) {
      setError('Token inválido. Confira e tente de novo.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="setup">
      <section className="setup-card login-card">
        <h1>Roteamento</h1>
        <p className="setup-subtitle">Este backend está protegido. Informe o token de acesso para continuar.</p>
        <form onSubmit={handleSubmit}>
          <label>Token de acesso
            <input
              type="password"
              autoFocus
              value={token}
              onChange={(e) => setTokenInput(e.target.value)}
              placeholder="Cole aqui o token combinado com o administrador"
            />
          </label>
          {error && <p className="login-error">{error}</p>}
          <button className="primary" type="submit" disabled={loading || !token}>
            {loading ? 'Verificando...' : 'Entrar'}
          </button>
        </form>
      </section>
    </main>
  );
}
