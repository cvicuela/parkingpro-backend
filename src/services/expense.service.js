const { query } = require('../config/database');
const { logAudit } = require('../middleware/audit');

class ExpenseService {
  async list({ limit = 50, offset = 0, category, status, fromDate, toDate, search } = {}) {
    let sql = `SELECT * FROM expenses WHERE 1=1`;
    const params = [];
    let idx = 1;

    if (status) { sql += ` AND status = $${idx++}`; params.push(status); }
    if (category) { sql += ` AND category = $${idx++}`; params.push(category); }
    if (fromDate) { sql += ` AND expense_date >= $${idx++}`; params.push(fromDate); }
    if (toDate) { sql += ` AND expense_date <= $${idx++}`; params.push(toDate); }
    if (search) {
      sql += ` AND (supplier_name ILIKE $${idx} OR description ILIKE $${idx} OR ncf ILIKE $${idx})`;
      params.push(`%${search}%`); idx++;
    }

    const countResult = await query(sql.replace('SELECT *', 'SELECT COUNT(*)'), params);
    sql += ` ORDER BY expense_date DESC LIMIT $${idx++} OFFSET $${idx++}`;
    params.push(limit, offset);

    const result = await query(sql, params);
    return { expenses: result.rows, total: parseInt(countResult.rows[0].count) };
  }

  async create(data, { userId, req } = {}) {
    const result = await query(
      `INSERT INTO expenses (category, expense_type, supplier_name, supplier_rnc, supplier_id_type,
        ncf, ncf_modified, description, expense_date, payment_date, subtotal, itbis_amount,
        itbis_retenido, itbis_sujeto_proporcionalidad, itbis_llevado_costo, itbis_por_adelantar,
        itbis_percibido, isr_retencion_type, isr_retenido, impuesto_selectivo, otros_impuestos,
        propina_legal, total, payment_method, status, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
      RETURNING *`,
      [data.category, data.expenseType || '02', data.supplierName, data.supplierRnc,
       data.supplierIdType || '1', data.ncf, data.ncfModified, data.description,
       data.expenseDate, data.paymentDate, data.subtotal || 0, data.itbisAmount || 0,
       data.itbisRetenido || 0, data.itbisProporcionalidad || 0, data.itbisCosto || 0,
       data.itbisAdelantar || 0, data.itbisPercibido || 0, data.isrType || null,
       data.isrRetenido || 0, data.impuestoSelectivo || 0, data.otrosImpuestos || 0,
       data.propinaLegal || 0, data.total || 0, data.paymentMethod || '04', 'active', userId]
    );

    if (userId && req) {
      await logAudit({ userId, action: 'expense_created', entityType: 'expense',
        entityId: result.rows[0].id, details: { category: data.category, total: data.total }, req });
    }
    return result.rows[0];
  }

  async update(id, data, { userId, req } = {}) {
    const result = await query(
      `UPDATE expenses SET
        category = COALESCE($1, category), supplier_name = COALESCE($2, supplier_name),
        supplier_rnc = COALESCE($3, supplier_rnc), ncf = COALESCE($4, ncf),
        description = COALESCE($5, description), subtotal = COALESCE($6, subtotal),
        itbis_amount = COALESCE($7, itbis_amount), total = COALESCE($8, total),
        expense_date = COALESCE($9, expense_date), payment_method = COALESCE($10, payment_method),
        updated_at = NOW()
      WHERE id = $11 RETURNING *`,
      [data.category, data.supplierName, data.supplierRnc, data.ncf,
       data.description, data.subtotal, data.itbisAmount, data.total,
       data.expenseDate, data.paymentMethod, id]
    );
    if (userId && req) {
      await logAudit({ userId, action: 'expense_updated', entityType: 'expense', entityId: id, req });
    }
    return result.rows[0];
  }

  async delete(id, { userId, req } = {}) {
    await query(`UPDATE expenses SET status = 'deleted', updated_at = NOW() WHERE id = $1`, [id]);
    if (userId && req) {
      await logAudit({ userId, action: 'expense_deleted', entityType: 'expense', entityId: id, req });
    }
  }

  async stats({ fromDate, toDate } = {}) {
    let where = `WHERE status = 'active'`;
    const params = [];
    if (fromDate) { where += ` AND expense_date >= $${params.length + 1}`; params.push(fromDate); }
    if (toDate) { where += ` AND expense_date <= $${params.length + 1}`; params.push(toDate); }

    const result = await query(
      `SELECT COUNT(*) as count, COALESCE(SUM(total), 0) as total_amount,
        COALESCE(SUM(itbis_amount), 0) as total_itbis,
        COALESCE(SUM(itbis_retenido), 0) as total_itbis_retenido,
        COALESCE(SUM(isr_retenido), 0) as total_isr_retenido
      FROM expenses ${where}`, params
    );
    return result.rows[0];
  }
}

module.exports = new ExpenseService();
