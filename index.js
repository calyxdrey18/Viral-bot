const express = require('express');
const app = express();
__path = process.cwd()
const bodyParser = require("body-parser");
const PORT = process.env.PORT || 8000;
let code = require('./pair'); 

app.use('/code', code);
app.use('/', async (req, res, next) => {
    res.sendFile(__path + '/main.html')
});

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.listen(PORT, () => {
    console.log(`
╔══════════════════════════════════════════════════════════════╗
║                                                              ║
║         VIRAL-BOT-MINI - WhatsApp Bot Server                 ║
║         Powered by Calyx Studio                              ║
║         Developer: Wesley                                    ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝

🚀 Server running on http://localhost:${PORT}
📞 Pairing endpoint: /code?number=YOUR_NUMBER
🔗 Example: http://localhost:${PORT}/code?number=263786624966

✅ Features:
   • Real WhatsApp pairing codes
   • Multi-session support
   • No database required
   • Command system with .menu
   • Group management

`)
});

module.exports = app;