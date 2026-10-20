export default function NoPermission() {
  return (
    <main className="main" style={{ maxWidth: 560, margin: '8vh auto' }}>
      <h1>Panel solo para responsables</h1>
      <p>Tu cuenta es de voluntario. Usa la app móvil Guardia para ver tus guardias, la agenda y responder a las alertas.</p>
      <form action="/auth/signout" method="post"><button className="btn">Cerrar sesión</button></form>
    </main>
  );
}
