import { useState } from 'react';
import { api } from './api.js';

function capacidadeValida(valor) {
  const n = Number(valor);
  return Number.isInteger(n) && n >= 1 && n <= 200;
}

export default function ImportKml({ onBack, onOpenDashboard }) {
  const [files, setFiles] = useState([]);
  const [tipoRota, setTipoRota] = useState('Entrada');
  const [capacidadePadrao, setCapacidadePadrao] = useState(22);
  const [preview, setPreview] = useState(null);
  const [capacidades, setCapacidades] = useState([]); // por rota, alinhado aos arquivos
  const [alocados, setAlocados] = useState([]); // opcional, alinhado aos arquivos
  const [resultado, setResultado] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  function montarForm({ confirmar, caps, aloc }) {
    const form = new FormData();
    files.forEach((file) => form.append('files', file));
    form.append('tipo_rota', tipoRota);
    form.append('capacidades', JSON.stringify(caps));
    form.append('alocados', JSON.stringify(aloc));
    form.append('confirmar', confirmar ? 'true' : 'false');
    return form;
  }

  function onPickFiles(event) {
    setFiles(Array.from(event.target.files || []));
    setPreview(null);
    setResultado(null);
    setError('');
  }

  async function analisar({ usarTabela }) {
    if (files.length === 0) return;
    setBusy(true);
    setError('');
    setResultado(null);
    try {
      const caps = usarTabela ? capacidades.map((c) => (c === '' ? null : Number(c))) : [Number(capacidadePadrao)];
      const aloc = usarTabela ? alocados.map((a) => (a === '' ? null : Number(a))) : [];
      const data = await api.importKml(montarForm({ confirmar: false, caps, aloc }));
      setPreview(data);
      if (!usarTabela) {
        setCapacidades(data.rotas.map((r) => String(r.capacidade ?? capacidadePadrao)));
        setAlocados(data.rotas.map(() => ''));
      }
    } catch (err) {
      setPreview(null);
      setError(err.message || 'Não foi possível analisar os arquivos.');
    } finally {
      setBusy(false);
    }
  }

  async function importar() {
    setBusy(true);
    setError('');
    try {
      const caps = capacidades.map((c) => Number(c));
      const aloc = alocados.map((a) => (a === '' ? null : Number(a)));
      const data = await api.importKml(montarForm({ confirmar: true, caps, aloc }));
      setResultado(data);
    } catch (err) {
      setError(err.message || 'Não foi possível importar.');
    } finally {
      setBusy(false);
    }
  }

  function reiniciar() {
    setFiles([]);
    setPreview(null);
    setResultado(null);
    setError('');
    setCapacidades([]);
    setAlocados([]);
  }

  const capacidadesOk = preview && capacidades.length === preview.rotas.length && capacidades.every(capacidadeValida);

  return (
    <main className="setup">
      <section className="setup-card dashboard-card">
        <div className="dashboard-header">
          <div>
            <h1>Importar rotas existentes</h1>
            <p className="setup-subtitle">
              Alimente o Cérebro e o ML com rotas que já funcionam, sem remontá-las no modo manual.
            </p>
          </div>
          <button className="secondary" onClick={onBack}>← Voltar</button>
        </div>

        <div className="note-box">
          Envie os KMLs de <strong>um único dia, turno e destino</strong> (um arquivo por rota, todas as rotas
          daquele dia). O ML aprende comparando &quot;mesma rota&quot; com &quot;rota diferente&quot;, então uma rota
          isolada não ensina quase nada. Só as <strong>coordenadas</strong> são lidas: nomes e descrições do KML são
          ignorados. Prefira dias variados em vez de muitos dias iguais.
        </div>

        {!resultado && (
          <div className="import-form">
            <div className="import-row">
              <label>
                Tipo de rota
                <select value={tipoRota} onChange={(e) => { setTipoRota(e.target.value); setPreview(null); }}>
                  <option value="Entrada">Entrada (destino = último ponto)</option>
                  <option value="Saída">Saída (destino = primeiro ponto)</option>
                </select>
              </label>
              <label>
                Capacidade padrão
                <input
                  type="number"
                  min="1"
                  max="200"
                  value={capacidadePadrao}
                  onChange={(e) => { setCapacidadePadrao(e.target.value); setPreview(null); }}
                />
              </label>
            </div>
            <label className="import-row">
              <input type="file" accept=".kml,application/vnd.google-earth.kml+xml,application/xml,text/xml" multiple onChange={onPickFiles} />
            </label>
            <div className="import-row">
              <button
                className="secondary"
                onClick={() => analisar({ usarTabela: false })}
                disabled={busy || files.length === 0 || !capacidadeValida(capacidadePadrao)}
              >
                {busy && !preview ? 'Analisando...' : `Analisar ${files.length > 0 ? `${files.length} arquivo(s)` : ''}`}
              </button>
            </div>
          </div>
        )}

        {error && <p className="login-error">{error}</p>}

        {preview && !resultado && (
          <>
            <h3 className="dashboard-section-title">Prévia</h3>
            <p className="muted-light small">
              {preview.totalColaboradores} passageiro(s) em {preview.rotas.length} rota(s) · {preview.tipoRota} · destino
              {' '}{preview.destino.lat.toFixed(4)}, {preview.destino.lon.toFixed(4)}
            </p>
            {preview.jaImportado && (
              <div className="note-box">
                Este conjunto de rotas já foi importado antes. Importar de novo só atualiza o cenário e{' '}
                <strong>não conta o aprendizado outra vez</strong>.
              </div>
            )}
            <div className="table-scroll">
              <table className="import-table">
                <thead>
                  <tr>
                    <th>Rota</th>
                    <th>Passageiros (KML)</th>
                    <th>Capacidade</th>
                    <th>Alocados informados (opcional)</th>
                    <th>Trajeto</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.rotas.map((rota, index) => (
                    <tr key={rota.arquivo + index}>
                      <td>{rota.nome}</td>
                      <td>{rota.passageiros}</td>
                      <td>
                        <input
                          type="number"
                          min="1"
                          max="200"
                          className={capacidadeValida(capacidades[index]) ? '' : 'bad'}
                          value={capacidades[index] ?? ''}
                          onChange={(e) => setCapacidades(capacidades.map((c, i) => (i === index ? e.target.value : c)))}
                        />
                      </td>
                      <td>
                        <input
                          type="number"
                          min="0"
                          value={alocados[index] ?? ''}
                          onChange={(e) => setAlocados(alocados.map((a, i) => (i === index ? e.target.value : a)))}
                        />
                      </td>
                      <td>{rota.distanciaKm !== null && rota.distanciaKm !== undefined ? `${rota.distanciaKm} km` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {preview.avisos.length > 0 && (
              <ul className="warn-list">
                {preview.avisos.map((aviso, index) => <li key={index}>{aviso}</li>)}
              </ul>
            )}
            <div className="dashboard-actions">
              <button className="secondary" onClick={() => analisar({ usarTabela: true })} disabled={busy || !capacidadesOk}>
                Reanalisar avisos
              </button>
              <button onClick={importar} disabled={busy || !capacidadesOk}>
                {busy ? 'Importando...' : 'Importar como cenário validado'}
              </button>
            </div>
          </>
        )}

        {resultado && (
          <>
            <div className="ok-box">
              Cenário importado: {resultado.totalColaboradores} passageiro(s) em {resultado.rotas.length} rota(s).{' '}
              {resultado.aprendizadoAplicado
                ? 'O Cérebro já aprendeu as conexões e separações deste dia.'
                : 'O cenário foi atualizado; o aprendizado não foi contado de novo.'}
            </div>
            <p className="muted-light small">
              Para o ML considerar o novo cenário agora, abra o Histórico e use &quot;Atualizar e retreinar ML&quot;.
            </p>
            <div className="dashboard-actions">
              <button onClick={onOpenDashboard}>Ver histórico</button>
              <button className="secondary" onClick={reiniciar}>Importar outro dia</button>
            </div>
          </>
        )}
      </section>
    </main>
  );
}
