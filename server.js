require('dotenv').config(); 
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, { 
  cors: { origin: "*", methods: ["GET", "POST"] } 
});

const JWT_SECRET = process.env.JWT_SECRET || 'dice_game_secret_key_123';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'supersecret123';

// ==========================================
// ၁။ Database ချိတ်ဆက်ခြင်း & Schemas
// ==========================================
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log('✅ MongoDB Connected Successfully!'))
  .catch(err => console.log('❌ MongoDB Connection Error:', err));

// Login/Signup အတွက် User Schema အသစ်
const User = mongoose.model('User', new mongoose.Schema({ 
  phone: { type: String, required: true, unique: true },
  username: { type: String, required: true },
  password: { type: String, required: true },
  balance: { type: Number, default: 10000 } 
}));

const BetHistory = mongoose.model('BetHistory', new mongoose.Schema({ 
  phone: String, 
  betType: String, 
  amount: Number, 
  result: String, 
  payout: Number, 
  createdAt: { type: Date, default: Date.now } 
}));

const Transaction = mongoose.model('Transaction', new mongoose.Schema({ 
  phone: String, 
  type: String, 
  amount: Number, 
  status: { type: String, default: 'pending' }, 
  createdAt: { type: Date, default: Date.now } 
}));

// ==========================================
// ၂။ Game State Variables
// ==========================================
let timeLeft = 15;
let gameStatus = 'BETTING'; 
let betPool = { under: 0, equal: 0, over: 0 };
let currentDiceResult = { dice1: 1, dice2: 1, total: 2 };
let globalTrend = []; 
let users = {}; 
let userPhones = {}; // socketId နဲ့ ဖုန်းနံပါတ် တွဲမှတ်ရန်
let currentRoundBets = {}; 

// ==========================================
// ၃။ Rigged Dice Logic (ဒိုင်အတွက် လျော်ကြေး အနည်းဆုံး တွက်ချက်ခြင်း)
// ==========================================
const calculateRiggedResult = () => {
  const { under, equal, over } = betPool;
  
  // ဘယ်သူမှ မလောင်းထားရင် ကျပန်း ပေါက်ပေးမယ်
  if (under === 0 && equal === 0 && over === 0) {
    const d1 = Math.floor(Math.random() * 6) + 1;
    const d2 = Math.floor(Math.random() * 6) + 1;
    return { dice1: d1, dice2: d2, total: d1 + d2 };
  }

  // အကွက်အလိုက် ဒိုင်က ပြန်လျော်ရမည့် ပမာဏ (Liability) ကို တွက်ချက်ခြင်း
  const underLiability = under * 2.3;
  const equalLiability = equal * 5.8; 
  const overLiability = over * 2.3;

  // လျော်ကြေးအနည်းဆုံး (ဒိုင်အမြတ်ဆုံး) အကွက်ကို ရှာခြင်း
  let minType = 'equal'; 
  let minLiability = equalLiability;

  if (underLiability < minLiability) { 
    minType = 'under'; 
    minLiability = underLiability; 
  }
  if (overLiability < minLiability) { 
    minType = 'over'; 
    minLiability = overLiability; 
  }

  let targetTotal;
  if (minType === 'under') {
    targetTotal = Math.floor(Math.random() * 5) + 2; 
  } else if (minType === 'over') {
    targetTotal = Math.floor(Math.random() * 5) + 8; 
  } else {
    targetTotal = 7; 
  }

  let d1, d2;
  do { 
    d1 = Math.floor(Math.random() * 6) + 1; 
    d2 = targetTotal - d1; 
  } while (d2 < 1 || d2 > 6);

  return { dice1: d1, dice2: d2, total: targetTotal };
};

// ==========================================
// ၄။ Main Game Loop (၁ စက္ကန့်တစ်ကြိမ်)
// ==========================================
setInterval(async () => {
  if (gameStatus === 'BETTING') {
    timeLeft--; 
    
    if (timeLeft === 0) {
      gameStatus = 'ROLLING'; 
      currentDiceResult = calculateRiggedResult();
      const total = currentDiceResult.total;
      
      let winningType = total < 7 ? 'under' : total > 7 ? 'over' : 'equal';

      globalTrend.push(winningType);
      if (globalTrend.length > 20) globalTrend.shift();

      let historyDocs = []; 

      // Payout ရှင်းခြင်း
      for (const [socketId, userBets] of Object.entries(currentRoundBets)) {
        if (users[socketId] !== undefined) {
          let totalWinAmount = 0;
          let totalBetAmount = 0;

          ['under', 'equal', 'over'].forEach(type => {
            if (userBets[type] > 0) {
              totalBetAmount += userBets[type];
              let winAmount = 0;
              let resultStatus = 'lose';

              if (type === winningType) {
                resultStatus = 'win';
                winAmount = Math.round(winningType === 'equal' ? userBets[type] * 5.8 : userBets[type] * 2.3); 
                totalWinAmount += winAmount;
              }
              
              historyDocs.push({
                phone: userPhones[socketId], 
                betType: type, 
                amount: userBets[type], 
                result: resultStatus, 
                payout: winAmount
              });
            }
          });

          if (totalWinAmount > 0) {
            users[socketId] += totalWinAmount; 
            io.to(socketId).emit('betResult', { status: 'win', amountWon: totalWinAmount, newBalance: users[socketId] });
          } else {
            io.to(socketId).emit('betResult', { status: 'lose', amountLost: totalBetAmount, newBalance: users[socketId] });
          }
          
          io.to(socketId).emit('balanceUpdate', users[socketId]);
          await User.findOneAndUpdate({ phone: userPhones[socketId] }, { balance: users[socketId] });
        }
      }

      if (historyDocs.length > 0) {
        await BetHistory.insertMany(historyDocs);
      }

      io.emit('gameUpdate', { timeLeft, gameStatus, betPool, globalTrend });
      io.emit('diceResult', currentDiceResult); 
      
      // ပြန်လည် စတင်ရန် ၅ စက္ကန့် စောင့်ဆိုင်းခြင်း
      setTimeout(() => {
        timeLeft = 15;
        gameStatus = 'BETTING';
        betPool = { under: 0, equal: 0, over: 0 }; 
        currentRoundBets = {}; 
      }, 5000); 
    }
  }
  
  if (gameStatus === 'BETTING') {
    io.emit('gameUpdate', { timeLeft, gameStatus, betPool, globalTrend });
  }
}, 1000); 

// ==========================================
// ၅။ Express API Routes
// ==========================================

// --- Auth Routes ---
app.post('/api/signup', async (req, res) => {
  const { phone, username, password } = req.body;
  if (!phone || !username || !password) return res.status(400).json({ error: 'အချက်အလက် အပြည့်အစုံ ဖြည့်ပါ' });
  
  try {
    let userExists = await User.findOne({ phone });
    if (userExists) return res.status(400).json({ error: 'ဒီဖုန်းနံပါတ်ဖြင့် အကောင့်ဖွင့်ပြီးသား ဖြစ်နေပါသည်' });
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const newUser = new User({ phone, username, password: hashedPassword, balance: 10000 });
    await newUser.save();

    const token = jwt.sign({ phone: newUser.phone, username: newUser.username }, JWT_SECRET);
    res.json({ message: 'Signup Success', token, phone: newUser.phone, username: newUser.username, balance: newUser.balance });
  } catch (error) { 
    res.status(500).json({ error: 'Server error during signup' }); 
  }
});

app.post('/api/login', async (req, res) => {
  const { phone, password } = req.body;
  if (!phone || !password) return res.status(400).json({ error: 'ဖုန်းနံပါတ် နှင့် စကားဝှက် ထည့်ပါ' });
  
  try {
    const user = await User.findOne({ phone });
    if (!user) return res.status(400).json({ error: 'အကောင့် မရှိပါ' });

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(400).json({ error: 'စကားဝှက် မှားယွင်းနေပါသည်' });

    const token = jwt.sign({ phone: user.phone, username: user.username }, JWT_SECRET);
    res.json({ message: 'Login Success', token, phone: user.phone, username: user.username, balance: user.balance });
  } catch (error) { 
    res.status(500).json({ error: 'Server error during login' }); 
  }
});

// --- Wallet & History Routes ---
app.post('/api/deposit', async (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount || amount <= 0) return res.status(400).json({ error: 'Invalid data' });
  try {
    const tx = new Transaction({ phone, type: 'deposit', amount, status: 'pending' });
    await tx.save();
    res.json({ message: 'Deposit requested successfully', transaction: tx });
  } catch (error) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/withdraw', async (req, res) => {
  const { phone, amount } = req.body;
  if (!phone || !amount || amount <= 0) return res.status(400).json({ error: 'Invalid data' });
  try {
    const dbUser = await User.findOne({ phone });
    if (!dbUser || dbUser.balance < amount) return res.status(400).json({ error: 'Insufficient balance' });

    dbUser.balance -= amount;
    await dbUser.save();

    const targetSocketId = Object.keys(userPhones).find(key => userPhones[key] === phone);
    if (targetSocketId) {
      users[targetSocketId] = dbUser.balance;
      io.to(targetSocketId).emit('balanceUpdate', users[targetSocketId]);
    }

    const tx = new Transaction({ phone, type: 'withdraw', amount, status: 'pending' });
    await tx.save();
    res.json({ message: 'Withdraw requested successfully' });
  } catch (error) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/history/bets/:phone', async (req, res) => {
  try { 
    const history = await BetHistory.find({ phone: req.params.phone }).sort({ createdAt: -1 }).limit(50);
    res.json(history); 
  } catch(e) { res.status(500).json({error: 'Server error'}); }
});

app.get('/api/history/transactions/:phone', async (req, res) => {
  try { 
    const txs = await Transaction.find({ phone: req.params.phone }).sort({ createdAt: -1 }).limit(50);
    res.json(txs); 
  } catch(e) { res.status(500).json({error: 'Server error'}); }
});

// --- Admin Routes ---
const isAdmin = (req, res, next) => {
  if (req.headers.admin_secret !== ADMIN_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  next();
};

app.get('/api/admin/transactions/pending', isAdmin, async (req, res) => {
  try { 
    res.json(await Transaction.find({ status: 'pending' }).sort({ createdAt: -1 })); 
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/admin/transaction/action', isAdmin, async (req, res) => {
  const { transactionId, action } = req.body;
  if (!transactionId || !['approve', 'reject'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
  
  try {
    const tx = await Transaction.findById(transactionId);
    if (!tx || tx.status !== 'pending') return res.status(400).json({ error: 'Transaction not found' });
    
    tx.status = action === 'approve' ? 'approved' : 'rejected';
    await tx.save();
    
    let dbUser = await User.findOne({ phone: tx.phone });
    if (tx.type === 'deposit' && action === 'approve') dbUser.balance += tx.amount;
    else if (tx.type === 'withdraw' && action === 'reject') dbUser.balance += tx.amount;
    await dbUser.save();
    
    const targetSocketId = Object.keys(userPhones).find(key => userPhones[key] === tx.phone);
    if (targetSocketId) {
      users[targetSocketId] = dbUser.balance;
      io.to(targetSocketId).emit('balanceUpdate', users[targetSocketId]);
      io.to(targetSocketId).emit('txUpdate', { type: tx.type, status: tx.status, amount: tx.amount });
    }
    res.json({ message: `Transaction ${action}d successfully` });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

// ==========================================
// ၆။ Socket Connection & Betting Validation
// ==========================================
io.on('connection', async (socket) => {
  const phone = socket.handshake.query.phone;
  if (!phone) return socket.disconnect(); // ဖုန်းနံပါတ်မပါဘဲ လှမ်းချိတ်ရင် ပယ်ချမည်

  try {
    let dbUser = await User.findOne({ phone });
    if (!dbUser) return socket.disconnect(); // Database ထဲမှာ အကောင့်မရှိရင် ပယ်ချမည်

    users[socket.id] = dbUser.balance; 
    userPhones[socket.id] = phone; 
    
    socket.emit('balanceUpdate', users[socket.id]);
    socket.emit('gameUpdate', { timeLeft, gameStatus, betPool, globalTrend });
  } catch (err) {
    console.log("Socket Connection Error:", err);
  }

  socket.on('placeBet', async (data) => {
    if (gameStatus === 'BETTING') {
      const betAmount = Number(data.amount);
      if (users[socket.id] >= betAmount && betAmount > 0) {
        
        if (!currentRoundBets[socket.id]) {
          currentRoundBets[socket.id] = { under: 0, equal: 0, over: 0 };
        }

        // 🚨 [စည်းကမ်းချက်] တစ်ပွဲလျှင် အများဆုံး ၂ ကွက်သာ လောင်းခွင့်ပြုမည်
        const activeBets = Object.keys(currentRoundBets[socket.id]).filter(type => currentRoundBets[socket.id][type] > 0);
        if (!activeBets.includes(data.type) && activeBets.length >= 2) {
          return socket.emit('errorMsg', 'တစ်ပွဲလျှင် အများဆုံး ၂ ကွက်သာ လောင်းနိုင်ပါသည်!');
        }

        users[socket.id] -= betAmount; 
        socket.emit('balanceUpdate', users[socket.id]); 

        currentRoundBets[socket.id][data.type] += betAmount; 
        betPool[data.type] += betAmount; 

        await User.findOneAndUpdate({ phone: userPhones[socket.id] }, { balance: users[socket.id] });
        io.emit('gameUpdate', { timeLeft, gameStatus, betPool, globalTrend });
      } else {
        socket.emit('errorMsg', 'Balance မလောက်ပါ!');
      }
    }
  });

  socket.on('disconnect', () => {
    delete users[socket.id]; 
    delete userPhones[socket.id]; 
    delete currentRoundBets[socket.id];
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => console.log(`Server running on port ${PORT}`));