var dummy = {};
    console.error('[Reminder Save Error]', err.message);
    return res.status(500).json({ error: 'Failed to create reminder.' });
  }
});

// GET /api/reminders — Get due/pending reminders
router.get('/reminders', (req, res) => {
  const user_id = getUserId(req);
  const due = req.query.due === 'true';
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);

  const database = getDb();

  try {
    let query, params;

    if (due) {
      query = `SELECT * FROM reminders WHERE user_id = ? AND remind_at <= ? AND reminded = 0 AND dismissed = 0 LIMIT ?`;
      params = [user_id, new Date().toISOString(), limit];
    } else {
      query = `SELECT * FROM reminders WHERE user_id = ? AND dismissed = 0 ORDER BY remind_at ASC LIMIT ?`;
      params = [user_id, limit];
    }

    const reminders = database.prepare(query).all(...params);
    return res.json({ reminders: reminders || [], total: reminders.length });
  } catch (err) {
    console.error('[Get Reminders Error]', err.message);
    return res.status(500).json({ error: 'Failed to load reminders.' });
  }