// Bank account shown to customers for transfer payments, per store (was hardcoded in the frontend).
exports.up = (pgm) => {
    pgm.addColumns('stores', {
        bank_name: { type: 'varchar(50)' },
        bank_account_number: { type: 'varchar(50)' },
        bank_account_name: { type: 'varchar(255)' },
    });
    // Seed every store with the account that was hardcoded in rpn-frontend/utils/config.ts.
    pgm.sql("UPDATE stores SET bank_name = 'BCA', bank_account_number = '1280119748', bank_account_name = 'Anggita Prima'");
};

exports.down = (pgm) => {
    pgm.dropColumns('stores', ['bank_name', 'bank_account_number', 'bank_account_name']);
};
