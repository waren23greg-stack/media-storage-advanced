fetch('http://localhost:5000/auth/login', {
  method: 'POST',
  headers: {'Content-Type':'application/json'},
  body: JSON.stringify({email: 'gregewaren@gmail.com', password: 'Admin1234'})
}).then(r=>r.json()).then(d => console.log(JSON.stringify(d)));
